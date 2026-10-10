import type { AssistantMessage, ToolResultMessage } from '@inkpi/protocol';
import { adoptMessage, commitMessage } from '../journal-commit.js';
import type { FinishTurnDecision } from '../types.js';
import type { TurnContext } from './turn-context.js';

export interface TurnFinalizeArgs {
  assistantMessage: AssistantMessage;
  toolResults: ToolResultMessage[];
  /** 是否有工具要求终止（拦截、覆写或生命周期异常）。 */
  shouldTerminateFromTools: boolean;
}

/**
 * 管线第四段：收尾本轮并决定是否继续循环。
 *
 * 判定顺序与拆分前一致：
 * 1. 工具要求终止 → 停止；
 * 2. `shouldStopAfterTurn` 返回真 → 停止；
 * 3. 本轮有工具调用 → 继续（让模型处理结果）；
 * 4. steering 队列非空 → 继续；
 * 5. follow-up 队列非空 → 排空一条并继续；
 * 6. 否则停止。
 */
export class TurnFinalizer {
  /** 返回是否应继续循环。 */
  public async finalize(ctx: TurnContext, args: TurnFinalizeArgs): Promise<boolean> {
    let decision: FinishTurnDecision | undefined;
    try {
      decision = await ctx.options.finishTurn?.(
        { assistantMessage: args.assistantMessage, toolResults: args.toolResults },
        ctx.signal
      );
    } finally {
      await ctx.emitEvent({
        type: 'turn_end',
        message: args.assistantMessage,
        toolResults: args.toolResults
      });
    }

    if (
      args.shouldTerminateFromTools ||
      ctx.signal?.aborted ||
      args.assistantMessage.stopReason === 'error' ||
      args.assistantMessage.stopReason === 'aborted' ||
      decision?.action === 'end'
    ) {
      return false;
    }

    if (ctx.options.shouldStopAfterTurn) {
      const stop = await ctx.options.shouldStopAfterTurn(
        { assistantMessage: args.assistantMessage, toolResults: args.toolResults },
        ctx.signal
      );
      if (stop) return false;
    }

    // 工具结果需要下一轮模型处理
    if (args.toolResults.length > 0) return true;

    // steering 消息需要下一轮消化
    if (ctx.steeringQueue.size() > 0) return true;

    return (await this.drainFollowUp(ctx)) || decision?.action === 'continue';
  }

  /** 排空一条 follow-up；有排到则返回真（表示应继续循环）。 */
  private async drainFollowUp(ctx: TurnContext): Promise<boolean> {
    if (ctx.followUpQueue.size() === 0) return false;

    const followUps = ctx.followUpQueue.drain(ctx.options.followUpMode || 'one-at-a-time');
    for (const fMsg of followUps) {
      const message = await commitMessage(ctx.options.journal, fMsg);
      adoptMessage(ctx.state, ctx.options.journal, message);
      await ctx.emitEvent({ type: 'message_start', message });
      await ctx.emitEvent({ type: 'message_end', message });
    }
    return true;
  }
}
