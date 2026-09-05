import type { EventStream } from '@inkpi/ai';
import { getThinkingBudgetForLevel, mapThinkingLevelToEffort, streamAi } from '@inkpi/ai';
import type { AgentMessage, AssistantMessage, AssistantMessageEvent } from '@inkpi/protocol';
import { AssistantFrameEncoder } from './assistant-frames.js';
import type { TurnContext } from './turn-context.js';

type AssistantEventStream = EventStream<AssistantMessageEvent>;

/**
 * 管线第二段：调用模型流式输出，并把增量合并进流式消息。
 *
 * 职责边界：
 * - 负责流式生命周期（`isStreaming` / `streamingMessage` / 中断信号接线）；
 * - 负责 `message_start` 与 `message_end` 的派发顺序；
 * - 负责把最终消息写入会话历史、记录错误、写入 journal。
 *
 * 不负责：上下文准备（见 `ContextTransformer`）与本轮是否继续（见 `TurnFinalizer`）。
 */
export class StreamInvoker {
  /** 流式调用模型，返回最终 assistant 消息。 */
  public async invoke(ctx: TurnContext, llmMessages: AgentMessage[]): Promise<AssistantMessage> {
    const { state, options, toolRegistry, emitEvent, signal, clock } = ctx;

    const streamOpId = `op_stream_${clock()}_${Math.random().toString(36).slice(2, 6)}`;
    if (options.journal) {
      options.journal.append('operation_intent', {
        id: streamOpId,
        type: 'provider_stream',
        intent: { model: state.model?.id, messageCount: llmMessages.length }
      });
    }

    const streamFn = options.streamFn || streamAi;
    const toolsMetadata = toolRegistry.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }));

    // 逐轮思考档位（对齐上游 pi v0.85.0 per-turn thinking effort）：
    // 支持 mid-convo effort 的模型走 effort 路径并记录档位；其余模型按级别取思考预算。
    const level = state.thinkingLevel;
    const effortEnabled = state.model.supportsMidConvoEffort === true && level !== 'none' && level !== 'off';
    const thinkingEffort = effortEnabled ? mapThinkingLevelToEffort(level) : undefined;
    const thinkingBudget = effortEnabled ? undefined : getThinkingBudgetForLevel(level);

    const stream = streamFn(state.model, llmMessages, {
      signal,
      systemPrompt: state.systemPrompt,
      ...(thinkingEffort !== undefined ? { thinkingEffort } : { thinkingBudget }),
      tools: toolsMetadata
    });

    const abortStream = (): void => stream.abort();
    if (signal?.aborted) {
      stream.abort();
    } else {
      signal?.addEventListener('abort', abortStream, { once: true });
    }

    state.isStreaming = true;
    const initialAssistantMsg: AssistantMessage = {
      role: 'assistant',
      content: [],
      // 记录当轮思考档位：回放历史时按轮还原 effort，避免中途调档串档。
      ...(thinkingEffort !== undefined ? { providerThinkingLevel: thinkingEffort } : {}),
      timestamp: clock()
    };
    state.streamingMessage = initialAssistantMsg;

    // 提供方可能在 streamFn 返回后立刻产出，因此先挂监听；
    // 再用一道闸门保证 message_start 先于首个 message_update 落定。
    const releaseMessageStart = this.attachDeltaListener(ctx, stream, streamOpId);

    await emitEvent({ type: 'message_start', message: initialAssistantMsg });
    releaseMessageStart();

    let assistantMessage: AssistantMessage;
    try {
      assistantMessage = await stream.collect();
      await stream.waitForListeners?.();
    } finally {
      signal?.removeEventListener('abort', abortStream);
    }

    state.isStreaming = false;
    state.streamingMessage = undefined;
    // collect() 产出的是流聚合的新消息对象，把当轮思考档位补写其上，
    // 使历史回放可按轮还原 effort（对齐上游 pi providerThinkingLevel）。
    if (thinkingEffort !== undefined) {
      assistantMessage.providerThinkingLevel = thinkingEffort;
    }
    state.messages.push(assistantMessage);
    if (assistantMessage.stopReason === 'error') {
      state.errorMessage = assistantMessage.errorMessage || 'Model stream ended with an error.';
    }

    if (options.journal) {
      options.journal.append('operation_settlement', {
        id: streamOpId,
        type: 'provider_stream',
        settlement: { usage: assistantMessage.usage, stopReason: assistantMessage.stopReason },
        error: assistantMessage.stopReason === 'error' ? assistantMessage.errorMessage : undefined
      });
      options.journal.append('agent_turn', assistantMessage);
    }

    await emitEvent({ type: 'message_end', message: assistantMessage });
    return assistantMessage;
  }

  /**
   * 挂载增量监听，返回解除"等待 message_start"闸门的函数。
   *
   * 监听内合并 text/thinking 增量到当前流式消息，再派发 `message_update`。
   * 同时（仅在配置 journal 时）把每个流事件编码为紧凑持久化帧并写入 journal，
   * 使崩溃后可从帧序列重建部分助手消息（对齐上游 pi assistant-durability；
   * 帧是辅助观察数据，`agent_turn` 结算落地后即被归约丢弃）。
   */
  private attachDeltaListener(ctx: TurnContext, stream: AssistantEventStream, streamOpId: string): () => void {
    let releaseMessageStart!: () => void;
    const messageStartSettled = new Promise<void>((resolve) => {
      releaseMessageStart = resolve;
    });

    const frameEncoder = ctx.options.journal ? new AssistantFrameEncoder() : undefined;

    stream.on(async (msgEvent) => {
      await messageStartSettled;
      if (frameEncoder) {
        const frame = frameEncoder.encode(msgEvent);
        if (frame) {
          ctx.options.journal.append('assistant_frame', { opId: streamOpId, frame });
        }
      }
      if (ctx.state.streamingMessage) {
        if (msgEvent.type === 'text_delta') {
          let textBlock = ctx.state.streamingMessage.content.find((b: any) => b.type === 'text') as any;
          if (!textBlock) {
            textBlock = { type: 'text', text: '' };
            ctx.state.streamingMessage.content.push(textBlock);
          }
          textBlock.text += msgEvent.textDelta;
        } else if (msgEvent.type === 'thinking_delta') {
          let thinkBlock = ctx.state.streamingMessage.content.find((b: any) => b.type === 'thinking') as any;
          if (!thinkBlock) {
            thinkBlock = { type: 'thinking', thinking: '' };
            ctx.state.streamingMessage.content.push(thinkBlock);
          }
          thinkBlock.thinking += msgEvent.thinkingDelta;
        }

        await ctx.emitEvent({
          type: 'message_update',
          message: ctx.state.streamingMessage,
          assistantMessageEvent: msgEvent
        });
      }
    });

    return releaseMessageStart;
  }
}
