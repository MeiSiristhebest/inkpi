import type { AgentEvent, AgentMessage } from '@inkpi/protocol';
import type { Clock } from '../ports/index.js';
import type { MessageQueue } from '../queues.js';
import type { ToolRegistry } from '../tools.js';
import type { AgentOptions, AgentState } from '../types.js';
import { ContextTransformer } from './context-transformer.js';
import { StreamInvoker } from './stream-invoker.js';
import { ToolDispatcher } from './tool-dispatcher.js';
import type { TurnContext } from './turn-context.js';
import { TurnFinalizer } from './turn-finalizer.js';

export interface RunLoopParams {
  state: AgentState;
  options: AgentOptions;
  toolRegistry: ToolRegistry;
  steeringQueue: MessageQueue;
  followUpQueue: MessageQueue;
  emitEvent: (event: AgentEvent) => Promise<void>;
  signal?: AbortSignal;
  /** Injectable clock for timestamps / ids. Defaults to `Date.now`. */
  clock?: Clock;
}

/**
 * Agent 主循环编排器。
 *
 * 循环体本身只做四件事，依次委托给四个管线阶段：
 *
 * `ContextTransformer`（准备消息）→ `StreamInvoker`（流式调用）→
 * `ToolDispatcher`（工具派发）→ `TurnFinalizer`（收尾与续跑判定）。
 *
 * 四个阶段均可在构造时替换，便于单独测试任一环节。
 */
export class AgentLoopRunner {
  private readonly contextTransformer: ContextTransformer;
  private readonly streamInvoker: StreamInvoker;
  private readonly toolDispatcher: ToolDispatcher;
  private readonly turnFinalizer: TurnFinalizer;

  constructor(stages: Partial<AgentLoopStages> = {}) {
    this.contextTransformer = stages.contextTransformer ?? new ContextTransformer();
    this.streamInvoker = stages.streamInvoker ?? new StreamInvoker();
    this.toolDispatcher = stages.toolDispatcher ?? new ToolDispatcher();
    this.turnFinalizer = stages.turnFinalizer ?? new TurnFinalizer();
  }

  public async run(params: RunLoopParams): Promise<AgentMessage[]> {
    const { state, options, toolRegistry, steeringQueue, followUpQueue, emitEvent, signal, clock = Date.now } = params;

    const ctx: TurnContext = {
      state,
      options,
      toolRegistry,
      steeringQueue,
      followUpQueue,
      emitEvent,
      signal,
      clock
    };

    state.errorMessage = undefined;
    await emitEvent({ type: 'agent_start' });

    try {
      let continueLoop = true;

      while (continueLoop) {
        if (signal?.aborted) break;

        await emitEvent({ type: 'turn_start' });

        const llmMessages = await this.contextTransformer.prepare(ctx);
        const assistantMessage = await this.streamInvoker.invoke(ctx, llmMessages);
        const { toolResults, shouldTerminate } = await this.toolDispatcher.dispatch(ctx, assistantMessage);

        continueLoop = await this.turnFinalizer.finalize(ctx, {
          assistantMessage,
          toolResults,
          shouldTerminateFromTools: shouldTerminate
        });
      }
    } catch (error) {
      state.errorMessage = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      state.isStreaming = false;
      state.streamingMessage = undefined;
      state.pendingToolCalls.clear();
      await emitEvent({ type: 'agent_end', messages: state.messages });
    }

    return state.messages;
  }
}

export interface AgentLoopStages {
  contextTransformer: ContextTransformer;
  streamInvoker: StreamInvoker;
  toolDispatcher: ToolDispatcher;
  turnFinalizer: TurnFinalizer;
}
