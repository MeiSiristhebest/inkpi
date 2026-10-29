import type {
  AgentEvent,
  AgentEventListener,
  AgentMessage,
  AgentTool,
  ContextEdit,
  ImageContent,
  JournalEntry,
  ModelToolDefinition,
  ToolRegistrationDescriptor,
  UserMessage
} from '@inkpi/protocol';
import { SessionCommitError } from '@inkpi/protocol';
import { ConversationContext, type ConversationModelContext } from './conversation-context.js';
import { ExtensionHost, ExtensionRunner } from './extension-host.js';
import { adoptMessage, commitJournal, commitMessage } from './journal-commit.js';
import { consoleLogger } from './ports/index.js';
import { REAL_CLOCK } from './ports/index.js';
import { restoreProviderSessionId } from './provider-session.js';
import { MessageQueue } from './queues.js';
import {
  detectAndMarkInterruptedOperations,
  planInterruptedRecovery,
  reduceSession
} from './reducer/session-reducer.js';
import {
  TOOL_SEARCH_NAME,
  createToolSearchTool,
  modelToolDefinition,
  modelToolDefinitionKey,
  readToolSearchActivations,
  toolDiscoveryFingerprint
} from './tool-discovery.js';
import { ToolRegistry } from './tools.js';
import { AgentLoopRunner } from './turn/agent-loop-runner.js';
import { ToolDispatcher } from './turn/tool-dispatcher.js';
import type { AgentOptions, AgentState, QueueMode } from './types.js';

const INCREMENTAL_CONTEXT_IDLE_RETENTION_MS = 5 * 60 * 1000;

/**
 * 纯粹 Agent 执行引擎核心（兼容别名 AgentEngine 见 src/deprecations.ts）
 * 严格遵循单一职责原则 (SRP)：
 * 仅负责状态机（AgentState）、双向队列调度（Steering/FollowUp）、工具执行与驱动推理循环（Agent Loop）。
 * 所有斜杠命令解释交由 SlashCommandRegistry，所有 RPC 通信交由 @inkpi/server 与 @inkpi/client。
 */
export class Agent {
  public state: AgentState;
  public steeringMode: QueueMode;
  public followUpMode: QueueMode;
  public toolExecution: 'parallel' | 'sequential';

  private options: AgentOptions;
  private toolRegistry = new ToolRegistry();
  private steeringQueue = new MessageQueue();
  private followUpQueue = new MessageQueue();
  private extensionHost = new ExtensionHost();
  private extensionRunner: ExtensionRunner;
  private listeners: AgentEventListener[] = [];
  private abortController: AbortController | null = null;
  private currentRunPromise: Promise<void> | null = null;
  private runActive = false;
  private readonly loopRunner = new AgentLoopRunner();
  private contextViewIdleTimer?: ReturnType<typeof setTimeout>;
  // 手动 compaction 的 idle 追踪（对齐上游 v0.85.0 #8920：abort 必须等待 compaction 收尾）。
  private compactionAbortController: AbortController | null = null;
  private compactionPromise: Promise<unknown> | null = null;
  private idleWait: { promise: Promise<void>; resolve: () => void } | null = null;

  private clock: () => number;
  private providerSessionPersisted = false;
  private readonly conversation?: ConversationContext;
  private initialMessagesRecorded = false;
  private recoveryChecked = false;
  private readonly historicalTools = new Map<string, { tool: AgentTool; registration?: ToolRegistrationDescriptor }>();
  private readonly pendingDeferredToolFingerprints = new Map<string, string>();
  private readonly toolSearchTool?: AgentTool;

  constructor(options: AgentOptions = {}) {
    this.options = { ...options };
    this.clock = options.clock || REAL_CLOCK;
    this.conversation =
      options.conversation ??
      (options.journal?.getEntries ? new ConversationContext(options.journal, this.clock) : undefined);
    if (this.conversation) {
      this.options.conversation = this.conversation;
      this.options.journal = this.conversation;
    }
    this.toolRegistry = new ToolRegistry(this.clock, options.monotonicClock);
    this.steeringMode = options.steeringMode || 'all';
    this.followUpMode = options.followUpMode || 'one-at-a-time';
    this.toolExecution = options.toolExecution || 'parallel';

    const init = options.initialState;
    if (!init?.model) {
      throw new Error('Agent requires an explicit model configuration. Use initialState.model or a test fixture.');
    }
    const restoredIdentity = restoreProviderSessionId(options.journal?.getEntries?.() ?? []);
    const requestedIdentity = options.providerSessionId ?? init.providerSessionId;
    if (requestedIdentity !== undefined && !requestedIdentity.trim()) {
      throw new Error('providerSessionId must not be empty.');
    }
    if (requestedIdentity && restoredIdentity && requestedIdentity !== restoredIdentity) {
      throw new Error('providerSessionId conflicts with the persisted conversation identity.');
    }
    const providerSessionId =
      restoredIdentity ?? requestedIdentity ?? options.providerSessionIdGenerator?.() ?? crypto.randomUUID();
    if (!providerSessionId.trim()) throw new Error('providerSessionIdGenerator returned an empty identity.');
    this.providerSessionPersisted = restoredIdentity !== undefined;
    this.state = {
      systemPrompt: init.systemPrompt ?? this.conversation?.getContext().loadout?.systemPrompt ?? '',
      model: init.model,
      thinkingLevel: init?.thinkingLevel || 'low',
      tools: init?.tools || [],
      messages: init?.messages ? [...init.messages] : (this.conversation?.getContext().rawMessages ?? []),
      isStreaming: false,
      streamingMessage: undefined,
      pendingToolCalls: new Set(),
      errorMessage: undefined,
      sessionId: options.sessionId ?? init.sessionId ?? options.journal?.sessionId,
      providerSessionId
    };

    if (init?.tools) {
      for (const t of init.tools) {
        this.toolRegistry.register(t);
      }
    }
    if (options.toolDiscovery) {
      if (this.toolRegistry.get(TOOL_SEARCH_NAME)) {
        throw new Error(`Tool name '${TOOL_SEARCH_NAME}' is reserved when tool discovery is enabled.`);
      }
      this.toolSearchTool = createToolSearchTool();
      this.toolRegistry.register(this.toolSearchTool, { source: 'runtime', capabilities: ['tool-discovery'] });
      this.state.tools = [...this.state.tools, this.toolSearchTool];
    }

    this.extensionRunner = new ExtensionRunner(this.extensionHost);
  }

  /**
   * 自动加载当前工作区与扩展目录下的所有插件（面向 Desktop/CLI 零摩擦）
   */
  public async loadWorkspacePlugins(baseDir?: string): Promise<void> {
    const targetDir = baseDir || (typeof process !== 'undefined' ? process.cwd() : '.');
    const { DynamicPluginLoader } = await import('./package-manager/dynamic-loader.js');
    const loader = new DynamicPluginLoader(this.extensionHost, this.extensionRunner);
    await loader.loadDefaultDirectories(targetDir);
  }

  public subscribe(listener: AgentEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) {
        this.listeners.splice(idx, 1);
      }
    };
  }

  private async emitEvent(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event, this.abortController?.signal);
      } catch (err) {
        consoleLogger.error('[Agent] Listener error:', err);
      }
    }
  }

  public async prompt(prompt: string | AgentMessage, images?: ImageContent[]): Promise<void> {
    this.claimRun();
    let msg: AgentMessage;

    try {
      if (typeof prompt === 'string') {
        const content = images && images.length > 0 ? [{ type: 'text' as const, text: prompt }, ...images] : prompt;

        msg = {
          role: 'user',
          content,
          timestamp: this.clock()
        } as UserMessage;
      } else {
        msg = prompt;
      }

      await this.persistProviderSession();
      await this.restoreInterruptedTools();
      this.abortController?.signal.throwIfAborted();
      await this.initializeConversation();
      msg = await commitMessage(this.options.journal, msg);
      adoptMessage(this.state, this.options.journal, msg);
      await this.emitEvent({ type: 'message_start', message: msg });
      await this.emitEvent({ type: 'message_end', message: msg });

      return this.run();
    } catch (error) {
      this.latchJournalFault(error);
      if (!this.currentRunPromise) this.finishContextMutation();
      throw error;
    }
  }

  public async continue(): Promise<void> {
    this.claimRun();
    try {
      await this.persistProviderSession();
      await this.restoreInterruptedTools();
      this.abortController?.signal.throwIfAborted();
      await this.initializeConversation();
      return this.run();
    } catch (error) {
      this.latchJournalFault(error);
      if (!this.currentRunPromise) this.finishContextMutation();
      throw error;
    }
  }

  private async persistProviderSession(): Promise<void> {
    if (this.providerSessionPersisted || !this.options.journal) return;
    await commitJournal(this.options.journal, [
      { type: 'provider_session', payload: { version: 1, id: this.state.providerSessionId } }
    ]);
    this.providerSessionPersisted = true;
  }

  public async recoverInterruptedTools(): Promise<void> {
    this.claimRun();
    this.recoveryChecked = false;
    try {
      await this.restoreInterruptedTools();
    } catch (error) {
      this.latchJournalFault(error);
      throw error;
    } finally {
      this.abortController = null;
      this.finishContextMutation();
    }
  }

  private async restoreInterruptedTools(): Promise<void> {
    if (this.recoveryChecked || !this.conversation) return;
    const recovered = detectAndMarkInterruptedOperations(reduceSession(this.getConversationPath()), this.clock);
    const registeredTools = this.mergedToolRegistry();
    const toolRegistry = this.modelVisibleRegistry(registeredTools);
    const plans = planInterruptedRecovery(recovered.state, toolRegistry);
    if (plans.length)
      await new ToolDispatcher().recover(
        {
          state: this.state,
          options: { ...this.options, ...this.toolHooks() },
          toolRegistry,
          currentTools: () => this.modelVisibleRegistry(this.mergedToolRegistry()),
          modelTools: () => this.getModelVisibleTools(registeredTools),
          modelToolAllowed: (name) => this.getModelVisibleTools(registeredTools).some((tool) => tool.name === name),
          steeringQueue: this.steeringQueue,
          followUpQueue: this.followUpQueue,
          emitEvent: (event) => this.emitEvent(event),
          signal: this.abortController?.signal,
          clock: this.clock
        },
        plans
      );
    this.recoveryChecked = true;
  }

  private async initializeConversation(): Promise<void> {
    if (!this.conversation) return;
    if (!this.initialMessagesRecorded) {
      const existing = new Set(this.conversation.getContext().rawMessages.map((message) => message.id));
      const captured: AgentMessage[] = [];
      for (const message of this.state.messages) {
        captured.push(
          message.id && existing.has(message.id) ? message : await commitMessage(this.options.journal, message)
        );
      }
      if (captured.some((message, index) => message !== this.state.messages[index])) this.state.messages = captured;
      this.initialMessagesRecorded = true;
    }
    const registry = this.mergedToolRegistry();
    for (const tool of registry.getAll())
      this.historicalTools.set(this.toolKey(tool), { tool, registration: registry.getRegistration(tool.name) });
    await this.conversation.recordLoadout(
      this.state.systemPrompt,
      this.getModelVisibleTools(registry).map((tool) => this.toolDefinition(tool))
    );
    if (this.options.toolDiscovery) this.state.tools = this.getModelVisibleTools(registry);
  }

  public getModelContext(headId?: string | null): ConversationModelContext {
    if (this.conversation) return this.conversation.getContext(headId);
    const messages = structuredClone(this.state.messages);
    const usageTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const message of messages)
      if (message.role === 'assistant' && message.usage) {
        usageTotals.inputTokens += message.usage.inputTokens;
        usageTotals.outputTokens += message.usage.outputTokens;
        usageTotals.totalTokens += message.usage.totalTokens;
      }
    return {
      headId: messages[messages.length - 1]?.id ?? null,
      messages,
      rawMessages: structuredClone(messages),
      usageTotals
    };
  }

  public getConversationPath(): JournalEntry[] {
    return this.conversation?.getPath() ?? [];
  }

  public async editContext(edit: ContextEdit): Promise<void> {
    if (!this.conversation) throw new Error('Context edits require a readable session journal.');
    this.claimRun();
    try {
      await this.initializeConversation();
      await commitJournal(this.options.journal, [{ type: 'context_edit', payload: edit }]);
      this.pendingDeferredToolFingerprints.clear();
      if (this.options.toolDiscovery) this.state.tools = this.getModelVisibleTools(this.mergedToolRegistry());
      this.loopRunner.clearIncrementalContextCache();
    } catch (error) {
      this.latchJournalFault(error);
      throw error;
    } finally {
      this.finishContextMutation();
    }
  }

  public async selectContextHead(headId: string | null): Promise<void> {
    if (!this.conversation) throw new Error('Context selection requires a readable session journal.');
    this.claimRun();
    const previousHead = this.conversation.getHeadId();
    try {
      if (!this.options.toolDiscovery) {
        for (const tool of this.toolRegistry.getAll())
          this.historicalTools.set(this.toolKey(tool), {
            tool,
            registration: this.toolRegistry.getRegistration(tool.name)
          });
      }
      const context = this.conversation.getContext(headId);
      const tools = this.options.toolDiscovery
        ? []
        : (context.loadout?.tools ?? []).map((definition) => {
            const historical = this.historicalTools.get(this.toolKey(definition));
            if (!historical)
              throw new Error(`Historical tool '${definition.name}' is not available with the recorded interface.`);
            return historical;
          });
      this.conversation.selectHead(headId);
      await commitJournal(this.options.journal, [
        { type: 'custom', payload: { kind: 'context_head', version: 1, headId } }
      ]);
      try {
        this.state.messages = context.rawMessages;
        this.state.systemPrompt = context.loadout?.systemPrompt ?? '';
        if (this.options.toolDiscovery) {
          this.pendingDeferredToolFingerprints.clear();
          this.state.tools = this.getModelVisibleTools(this.mergedToolRegistry());
        } else {
          const registry = new ToolRegistry(this.clock, this.options.monotonicClock);
          for (const { tool, registration } of tools) registry.register(tool, registration);
          this.toolRegistry = registry;
          this.state.tools = tools.map(({ tool }) => tool);
        }
      } catch (error) {
        throw new SessionCommitError('Context head committed but adoption failed.', 'unknown', { cause: error });
      }
      this.initialMessagesRecorded = true;
      this.recoveryChecked = false;
      this.loopRunner.clearIncrementalContextCache();
    } catch (error) {
      this.latchJournalFault(error);
      if (!this.state.isFaulted) this.conversation.selectHead(previousHead);
      throw error;
    } finally {
      this.finishContextMutation();
    }
  }

  private finishContextMutation(): void {
    this.runActive = false;
    this.abortController = null;
    this.resolveIdleWaitIfIdle();
    this.scheduleContextViewExpiry();
  }

  private toolDefinition(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>): ModelToolDefinition {
    return { name: tool.name, description: tool.description, parameters: tool.parameters ?? { type: 'object' } };
  }
  private toolKey(tool: Pick<AgentTool, 'name' | 'description' | 'parameters'>): string {
    return JSON.stringify(this.toolDefinition(tool));
  }

  public steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  public followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  /**
   * 清空排队中的 steering 与 follow-up 消息（对齐上游 v0.84.4 PR #8432：clear_queue）。
   * 返回被丢弃的消息数量。
   */
  public clearQueues(): { steering: number; followUp: number } {
    const steeringCount = this.steeringQueue.size();
    const followUpCount = this.followUpQueue.size();
    this.steeringQueue.clear();
    this.followUpQueue.clear();
    this.clearContextViewIdleTimer();
    this.loopRunner.clearIncrementalContextCache();
    return { steering: steeringCount, followUp: followUpCount };
  }

  /**
   * 是否存在进行中的手动 compaction（参与 idle 追踪，对齐上游 pi isIdle 语义）。
   */
  public get isCompacting(): boolean {
    return this.compactionPromise !== null;
  }

  /**
   * 会话是否空闲：无进行中的 agent run，也无进行中的 compaction（对齐上游 pi #8920）。
   */
  public get isIdle(): boolean {
    return !this.runActive && !this.isCompacting;
  }

  public abortCompaction(): void {
    if (this.compactionAbortController) {
      this.compactionAbortController.abort();
    }
  }

  /**
   * 在 Agent 的 idle 追踪与 abort 所有权下执行手动 compaction。
   * 任务收到的 AbortSignal 会在 `abort()`（或 `abortCompaction()`）时被触发；
   * 运行期间 `isIdle` 返回 false，`waitForIdle()` 会等待其落定。
   */
  public async runCompaction<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.compactionPromise) {
      throw new Error('A compaction is already in progress. Wait for it to settle or abort it first.');
    }
    const controller = new AbortController();
    this.compactionAbortController = controller;
    const promise = (async () => {
      try {
        return await task(controller.signal);
      } finally {
        this.compactionAbortController = null;
        this.compactionPromise = null;
        this.resolveIdleWaitIfIdle();
      }
    })();
    this.compactionPromise = promise;
    return promise;
  }

  /**
   * 中止当前操作并等待会话空闲（含 compaction 收尾）后才返回。
   * 对齐上游 pi：RPC `abort` 必须等到取消真正落定，而非报告成功却仍在压缩。
   */
  public async abort(): Promise<void> {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.abortCompaction();
    await this.waitForIdle();
  }

  public async waitForIdle(): Promise<void> {
    if (this.isIdle) return;
    if (!this.idleWait) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      this.idleWait = { promise, resolve };
    }
    await this.idleWait.promise;
  }

  private resolveIdleWaitIfIdle(): void {
    if (!this.isIdle || !this.idleWait) return;
    const waiter = this.idleWait;
    this.idleWait = null;
    waiter.resolve();
  }

  public reset(): void {
    if (this.runActive || this.currentRunPromise) {
      throw new Error('Agent is already processing. Wait for completion before resetting.');
    }
    if (this.compactionPromise) {
      throw new Error('A compaction is in progress. Wait for it to settle or abort it before resetting.');
    }
    this.abort();
    this.state.messages = [];
    this.conversation?.selectHead(null);
    this.state.isStreaming = false;
    this.state.streamingMessage = undefined;
    this.state.pendingToolCalls.clear();
    this.state.errorMessage = undefined;
    this.steeringQueue.clear();
    this.followUpQueue.clear();
  }

  public getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * 通知前端/RPC 进入交互式等待状态（对齐上游 v0.84.4 PR #8355：ui_prompt_start / ui_prompt_end）。
   * 让宿主进程或 RPC 客户端明确感知“当前挂起源于等待人工输入或门禁确认”，而非 AI 卡顿或网络超时。
   */
  public async notifyUiPromptStart(promptId: string, title?: string): Promise<void> {
    await this.emitEvent({ type: 'ui_prompt_start', promptId, title });
  }

  public async notifyUiPromptEnd(
    promptId: string,
    response?: Record<string, unknown> | string | boolean
  ): Promise<void> {
    await this.emitEvent({ type: 'ui_prompt_end', promptId, response });
  }

  public getExtensionHost(): ExtensionHost {
    return this.extensionHost;
  }

  public getExtensionRunner(): ExtensionRunner {
    return this.extensionRunner;
  }

  private async run(): Promise<void> {
    const abortController = this.abortController;
    if (!abortController) {
      throw new Error('Agent run was not claimed before starting.');
    }

    const mergedTools = this.mergedToolRegistry();
    for (const tool of mergedTools.getAll())
      this.historicalTools.set(this.toolKey(tool), { tool, registration: mergedTools.getRegistration(tool.name) });

    const runPromise = this.loopRunner.run({
      state: this.state,
      options: {
        ...this.options,
        ...this.toolHooks(),
        prepareRequest: async (request, signal) => {
          const prepared = await this.options.prepareRequest?.(request, signal);
          if (!prepared?.tools) return prepared;
          const hiddenNames = new Set(
            mergedTools
              .getAll()
              .filter((tool) => mergedTools.getRegistration(tool.name)?.exposure === 'hidden')
              .map((tool) => tool.name)
          );
          const visibleNames = this.options.toolDiscovery
            ? new Set(this.getModelVisibleTools(mergedTools).map((tool) => tool.name))
            : undefined;
          return {
            ...prepared,
            tools: prepared.tools.filter(
              (tool) => !hiddenNames.has(tool.name) && (!visibleNames || visibleNames.has(tool.name))
            )
          };
        },
        transformContext: async (msgs, signal) => {
          let transformed = msgs;
          if (this.options.transformContext) {
            transformed = await this.options.transformContext(transformed, signal);
          }
          return this.extensionHost.transformContext(transformed, signal);
        }
      },
      toolRegistry: mergedTools,
      currentTools: () => this.mergedToolRegistry(),
      modelTools: () => this.getModelVisibleTools(mergedTools),
      modelToolAllowed: (name) => this.getModelVisibleTools(mergedTools).some((tool) => tool.name === name),
      steeringQueue: this.steeringQueue,
      followUpQueue: this.followUpQueue,
      emitEvent: (ev) => this.emitEvent(ev),
      signal: abortController.signal,
      clock: this.clock
    });

    const settledRunPromise = runPromise.then(
      () => undefined,
      () => undefined
    );
    this.currentRunPromise = settledRunPromise;
    try {
      await runPromise;
    } catch (error) {
      this.latchJournalFault(error);
      throw error;
    } finally {
      if (this.currentRunPromise === settledRunPromise) {
        this.currentRunPromise = null;
      }
      this.abortController = null;
      this.runActive = false;
      this.resolveIdleWaitIfIdle();
      this.scheduleContextViewExpiry();
    }
  }

  private clearContextViewIdleTimer(): void {
    if (this.contextViewIdleTimer !== undefined) clearTimeout(this.contextViewIdleTimer);
    this.contextViewIdleTimer = undefined;
  }

  private mergedToolRegistry(): ToolRegistry {
    const extensionTools = this.extensionHost.getTools();
    if (
      this.toolSearchTool &&
      (this.toolRegistry.get(TOOL_SEARCH_NAME) !== this.toolSearchTool ||
        extensionTools.some((tool) => tool.name === TOOL_SEARCH_NAME))
    ) {
      throw new Error(`Tool name '${TOOL_SEARCH_NAME}' is reserved when tool discovery is enabled.`);
    }
    const merged = new ToolRegistry(this.clock, this.options.monotonicClock);
    for (const tool of this.toolRegistry.getAll()) merged.register(tool, this.toolRegistry.getRegistration(tool.name));
    for (const tool of extensionTools) merged.register(tool, this.extensionHost.getToolRegistration(tool.name));
    return merged;
  }

  private getModelVisibleTools(frozenRegistry: ToolRegistry): AgentTool[] {
    const currentRegistry = this.mergedToolRegistry();
    const loadout = new Map(
      (this.conversation?.getLoadout()?.tools ?? []).map((definition) => [
        definition.name,
        modelToolDefinitionKey(definition)
      ])
    );
    const direct: AgentTool[] = [];
    const deferred: AgentTool[] = [];
    for (const tool of frozenRegistry.getAll()) {
      const registration = frozenRegistry.getRegistration(tool.name);
      const current = currentRegistry.get(tool.name);
      const currentRegistration = currentRegistry.getRegistration(tool.name);
      if (
        !registration ||
        current !== tool ||
        JSON.stringify(currentRegistration) !== JSON.stringify(registration) ||
        registration.exposure === 'hidden'
      )
        continue;
      const exposure = registration.exposure ?? 'direct';
      if (!this.options.toolDiscovery || exposure === 'direct') {
        direct.push(tool);
        continue;
      }
      if (exposure !== 'deferred') continue;
      const fingerprint = toolDiscoveryFingerprint(tool, registration);
      if (
        this.pendingDeferredToolFingerprints.get(tool.name) === fingerprint ||
        loadout.get(tool.name) === modelToolDefinitionKey(modelToolDefinition(tool))
      ) {
        deferred.push(tool);
      }
    }
    // Keep the always-visible declaration prefix stable as deferred tools are activated or revoked.
    return this.options.toolDiscovery ? [...direct, ...deferred] : direct;
  }

  private modelVisibleRegistry(frozenRegistry: ToolRegistry): ToolRegistry {
    const visible = new ToolRegistry(this.clock, this.options.monotonicClock);
    for (const tool of this.getModelVisibleTools(frozenRegistry)) {
      visible.register(tool, frozenRegistry.getRegistration(tool.name));
    }
    return visible;
  }

  private toolHooks(): Pick<AgentOptions, 'beforeToolCall' | 'afterToolCall'> {
    return {
      beforeToolCall: async (event, signal) => {
        const explicit = await this.options.beforeToolCall?.(event, signal);
        if (explicit?.block) return explicit;
        return this.extensionHost.executeBeforeToolCall({
          toolCallId: event.toolCall.id,
          toolName: event.toolCall.name,
          parameters: event.toolCall.arguments
        });
      },
      afterToolCall: async (event, signal) => {
        const explicit = await this.options.afterToolCall?.(event, signal);
        const after =
          explicit ??
          (await this.extensionHost.executeAfterToolCall({
            toolCallId: event.toolCall.id,
            toolName: event.toolCall.name,
            parameters: event.toolCall.arguments,
            result: event.result,
            isError: event.isError
          }));
        if (
          this.toolSearchTool &&
          event.toolCall.name === TOOL_SEARCH_NAME &&
          !event.isError &&
          after?.isError !== true &&
          !after?.terminate &&
          !signal?.aborted
        ) {
          const registry = this.mergedToolRegistry();
          for (const activation of readToolSearchActivations(event.result.details)) {
            const tool = registry.get(activation.name);
            const registration = registry.getRegistration(activation.name);
            if (
              tool &&
              registration?.exposure === 'deferred' &&
              toolDiscoveryFingerprint(tool, registration) === activation.fingerprint
            ) {
              this.pendingDeferredToolFingerprints.set(activation.name, activation.fingerprint);
            }
          }
        }
        return after;
      }
    };
  }

  private scheduleContextViewExpiry(): void {
    this.clearContextViewIdleTimer();
    if (!this.options.incrementalTransformContext && !this.conversation) return;

    this.contextViewIdleTimer = setTimeout(() => {
      this.contextViewIdleTimer = undefined;
      if (!this.runActive && !this.compactionPromise) {
        this.loopRunner.clearIncrementalContextCache();
        this.conversation?.clearCache();
      }
    }, INCREMENTAL_CONTEXT_IDLE_RETENTION_MS);
    (this.contextViewIdleTimer as unknown as { unref?: () => void }).unref?.();
  }

  private claimRun(): void {
    if (this.state.isFaulted)
      throw new Error('Session persistence outcome is unknown. Reconstruct the session before continuing.');
    if (this.runActive) {
      throw new Error(
        'Agent already has a run in progress. Wait for it to finish or abort it before starting another run.'
      );
    }
    this.clearContextViewIdleTimer();
    this.runActive = true;
    this.abortController = new AbortController();
  }

  private latchJournalFault(error: unknown): void {
    if (error instanceof SessionCommitError && error.certainty === 'unknown') this.state.isFaulted = true;
  }
}
