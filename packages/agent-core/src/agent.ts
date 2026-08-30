import type {
  AgentEvent,
  AgentEventListener,
  AgentMessage,
  ImageContent,
  UserMessage
} from '@inkpi/protocol';
import { getModelPreset } from '@inkpi/ai';
import type { AgentOptions, AgentState, QueueMode } from './types.js';
import { ToolRegistry } from './tools.js';
import { SteeringQueue, FollowUpQueue } from './queues.js';
import { ExtensionHost, ExtensionRunner } from './extension-host.js';
import { runAgentLoop } from './loop.js';

export class Agent {
  public state: AgentState;
  public steeringMode: QueueMode;
  public followUpMode: QueueMode;
  public toolExecution: 'parallel' | 'sequential';

  private options: AgentOptions;
  private toolRegistry = new ToolRegistry();
  private steeringQueue = new SteeringQueue();
  private followUpQueue = new FollowUpQueue();
  private extensionHost = new ExtensionHost();
  private extensionRunner: ExtensionRunner;
  private listeners: AgentEventListener[] = [];
  private abortController: AbortController | null = null;
  private currentRunPromise: Promise<void> | null = null;

  constructor(options: AgentOptions = {}) {
    this.options = options;
    this.steeringMode = options.steeringMode || 'all';
    this.followUpMode = options.followUpMode || 'one-at-a-time';
    this.toolExecution = options.toolExecution || 'parallel';

    const init = options.initialState;
    this.state = {
      systemPrompt: init?.systemPrompt || '你是一位专精长篇小说与网文创作的顶尖文学 Agent 助手。',
      model: init?.model || getModelPreset('mock-test'),
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
        console.error('[Agent] Listener error:', err);
      }
    }
  }

  public async prompt(prompt: string | AgentMessage, images?: ImageContent[]): Promise<void> {
    let msg: AgentMessage;

    if (typeof prompt === 'string') {
      const content = images && images.length > 0
        ? [{ type: 'text' as const, text: prompt }, ...images]
        : prompt;

      msg = {
        role: 'user',
        content,
        timestamp: Date.now()
      } as UserMessage;
    } else {
      msg = prompt;
    }

    this.state.messages.push(msg);
    await this.emitEvent({ type: 'message_start', message: msg });
    await this.emitEvent({ type: 'message_end', message: msg });

    return this.run();
  }

  public async continue(): Promise<void> {
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
    this.abortController = new AbortController();

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
      signal: this.abortController.signal
    });

    this.currentRunPromise = runPromise.then(() => {}).catch(() => {});
    await runPromise;
    this.currentRunPromise = null;
  }
}
