import type { AgentEvent, AgentEventListener, AgentMessage, ImageContent, UserMessage } from '@inkpi/protocol';
import { ExtensionHost, ExtensionRunner } from './extension-host.js';
import { runAgentLoop } from './loop.js';
import { consoleLogger } from './ports/index.js';
import { REAL_CLOCK } from './ports/index.js';
import { MessageQueue } from './queues.js';
import { ToolRegistry } from './tools.js';
import type { AgentOptions, AgentState, QueueMode } from './types.js';

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
  // 手动 compaction 的 idle 追踪（对齐上游 v0.85.0 #8920：abort 必须等待 compaction 收尾）。
  private compactionAbortController: AbortController | null = null;
  private compactionPromise: Promise<unknown> | null = null;
  private idleWait: { promise: Promise<void>; resolve: () => void } | null = null;

  constructor(options: AgentOptions = {}) {
    this.options = options;
    this.steeringMode = options.steeringMode || 'all';
    this.followUpMode = options.followUpMode || 'one-at-a-time';
    this.toolExecution = options.toolExecution || 'parallel';

    const init = options.initialState;
    if (!init?.model) {
      throw new Error('Agent requires an explicit model configuration. Use initialState.model or a test fixture.');
    }
    this.state = {
      systemPrompt: init.systemPrompt ?? '',
      model: init.model,
      thinkingLevel: init?.thinkingLevel || 'low',
      tools: init?.tools || [],
      messages: init?.messages ? [...init.messages] : [],
      isStreaming: false,
      streamingMessage: undefined,
      pendingToolCalls: new Set(),
      errorMessage: undefined
    };

    if (init?.tools) {
      for (const t of init.tools) {
        this.toolRegistry.register(t);
      }
    }

    this.extensionRunner = new ExtensionRunner(this.extensionHost);
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
          timestamp: Date.now()
        } as UserMessage;
      } else {
        msg = prompt;
      }

      this.state.messages.push(msg);
      if (this.options.journal) {
        this.options.journal.append('user_message', msg);
      }
      await this.emitEvent({ type: 'message_start', message: msg });
      await this.emitEvent({ type: 'message_end', message: msg });

      return this.run();
    } catch (error) {
      if (!this.currentRunPromise) this.runActive = false;
      throw error;
    }
  }

  public async continue(): Promise<void> {
    this.claimRun();
    return this.run();
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

    const mergedTools = new ToolRegistry();
    for (const t of this.toolRegistry.getAll()) {
      mergedTools.register(t);
    }
    for (const t of this.extensionHost.getTools()) {
      mergedTools.register(t);
    }

    const runPromise = runAgentLoop({
      state: this.state,
      options: {
        ...this.options,
        transformContext: async (msgs, signal) => {
          let transformed = msgs;
          if (this.options.transformContext) {
            transformed = await this.options.transformContext(transformed, signal);
          }
          return this.extensionHost.transformContext(transformed, signal);
        }
      },
      toolRegistry: mergedTools,
      steeringQueue: this.steeringQueue,
      followUpQueue: this.followUpQueue,
      emitEvent: (ev) => this.emitEvent(ev),
      signal: abortController.signal,
      clock: REAL_CLOCK
    });

    const settledRunPromise = runPromise.then(
      () => undefined,
      () => undefined
    );
    this.currentRunPromise = settledRunPromise;
    try {
      await runPromise;
    } finally {
      if (this.currentRunPromise === settledRunPromise) {
        this.currentRunPromise = null;
      }
      this.abortController = null;
      this.runActive = false;
      this.resolveIdleWaitIfIdle();
    }
  }

  private claimRun(): void {
    if (this.runActive) {
      throw new Error(
        'Agent already has a run in progress. Wait for it to finish or abort it before starting another run.'
      );
    }
    this.runActive = true;
    this.abortController = new AbortController();
  }
}
