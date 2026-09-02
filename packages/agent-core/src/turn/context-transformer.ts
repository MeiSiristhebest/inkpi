import type { AgentMessage } from '@inkpi/protocol';
import type { TurnContext } from './turn-context.js';

/**
 * 管线第一段：准备本轮投喂给模型的消息。
 *
 * 依次完成三件事：
 * 1. 排空 steering 队列，把消息并入会话历史并派发生命周期事件；
 * 2. 应用 `transformContext`（可选）做上下文裁剪/压缩；
 * 3. 应用 `convertToLlm`（可选）转换为模型可接受的格式。
 */
export class ContextTransformer {
  /** 返回应当发送给模型的消息列表。 */
  public async prepare(ctx: TurnContext): Promise<AgentMessage[]> {
    await this.drainSteering(ctx);

    let workingMessages = [...ctx.state.messages];
    if (ctx.options.transformContext) {
      workingMessages = await ctx.options.transformContext(workingMessages, ctx.signal);
    }

    return ctx.options.convertToLlm
      ? await ctx.options.convertToLlm(workingMessages)
      : workingMessages;
  }

  /**
   * 排空 steering 队列并入历史。
   *
   * 每条消息都完整派发 `message_start` / `message_end`，
   * 使其与模型产出的消息在事件流中不可区分。
   */
  private async drainSteering(ctx: TurnContext): Promise<void> {
    const steeringMsgs = ctx.steeringQueue.drain(ctx.options.steeringMode || 'all');
    for (const sMsg of steeringMsgs) {
      ctx.state.messages.push(sMsg);
      await ctx.emitEvent({ type: 'message_start', message: sMsg });
      await ctx.emitEvent({ type: 'message_end', message: sMsg });
    }
  }
}
