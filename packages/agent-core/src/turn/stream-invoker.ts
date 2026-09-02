import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent
} from '@inkpi/protocol';
import type { EventStream } from '@inkpi/ai';
import { streamAi } from '@inkpi/ai';
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

    const stream = streamFn(state.model, llmMessages, {
      signal,
      systemPrompt: state.systemPrompt,
      thinkingBudget: state.thinkingLevel === 'off' ? 0 : 2000,
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
      timestamp: clock()
    };
    state.streamingMessage = initialAssistantMsg;

    // 提供方可能在 streamFn 返回后立刻产出，因此先挂监听；
    // 再用一道闸门保证 message_start 先于首个 message_update 落定。
    const releaseMessageStart = this.attachDeltaListener(ctx, stream);

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
    state.messages.push(assistantMessage);
    if (assistantMessage.stopReason === 'error') {
      state.errorMessage = assistantMessage.errorMessage || 'Model stream ended with an error.';
    }

    if (options.journal) {
      options.journal.append('operation_settlement', {
        id: streamOpId,
        type: 'provider_stream',
        settlement: { usage: assistantMessage.usage, stopReason: assistantMessage.stopReason },
        error:
          assistantMessage.stopReason === 'error' ? assistantMessage.errorMessage : undefined
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
   */
  private attachDeltaListener(ctx: TurnContext, stream: AssistantEventStream): () => void {
    let releaseMessageStart!: () => void;
    const messageStartSettled = new Promise<void>((resolve) => {
      releaseMessageStart = resolve;
    });

    stream.on(async (msgEvent) => {
      await messageStartSettled;
      if (ctx.state.streamingMessage) {
        if (msgEvent.type === 'text_delta') {
          let textBlock = ctx.state.streamingMessage.content.find(
            (b: any) => b.type === 'text'
          ) as any;
          if (!textBlock) {
            textBlock = { type: 'text', text: '' };
            ctx.state.streamingMessage.content.push(textBlock);
          }
          textBlock.text += msgEvent.textDelta;
        } else if (msgEvent.type === 'thinking_delta') {
          let thinkBlock = ctx.state.streamingMessage.content.find(
            (b: any) => b.type === 'thinking'
          ) as any;
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
