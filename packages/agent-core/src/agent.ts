import type { AgentEvent, AgentEventListener, AgentMessage, ImageContent, UserMessage } from '@inkpi/protocol';
import { ExtensionHost, ExtensionRunner } from './extension-host.js';
import { runAgentLoop } from './loop.js';
import { consoleLogger } from './ports/index.js';
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

  public abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  public async waitForIdle(): Promise<void> {
    if (this.currentRunPromise) {
      await this.currentRunPromise;
    }
  }

  public reset(): void {
    if (this.runActive || this.currentRunPromise) {
      throw new Error('Agent is already processing. Wait for completion before resetting.');
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
      signal: abortController.signal
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
