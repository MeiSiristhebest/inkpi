import type {
  AssistantMessage,
  ToolCallContent,
  ToolResultMessage
} from '@inkpi/protocol';
import { runWithConcurrency } from '../concurrency.js';
import { extractToolCalls } from './extract-tool-calls.js';
import type { TurnContext } from './turn-context.js';

export interface ToolDispatchResult {
  /** 本轮产生的工具结果消息，按工具调用顺序排列。 */
  toolResults: ToolResultMessage[];
  /** 是否有任何工具要求终止循环。 */
  shouldTerminate: boolean;
}

/** 跨并发调用共享的终止标记。用对象承载，便于作为形参显式传递。 */
interface TerminationFlag {
  value: boolean;
}

/**
 * 管线第三段：执行 assistant 消息中的工具调用。
 *
 * 单个工具的生命周期为：journal 意图登记 → 中断检查 → `tool_execution_start`
 * → `beforeToolCall` 门控 → 实际执行或拦截 → `afterToolCall` 覆写 →
 * journal 结算 → `tool_execution_end`。并发策略由 `options.toolExecution` 决定，
 * 统一走 `runWithConcurrency`。
 */
export class ToolDispatcher {
  /** 执行工具调用，并把结果消息并入会话历史。 */
  public async dispatch(
    ctx: TurnContext,
    assistantMessage: AssistantMessage
  ): Promise<ToolDispatchResult> {
    const toolCalls = extractToolCalls(assistantMessage);
    const toolResults: ToolResultMessage[] = [];
    const termination: TerminationFlag = { value: false };

    if (toolCalls.length === 0) {
      return { toolResults, shouldTerminate: false };
    }

    const results = await runWithConcurrency(
      toolCalls,
      (call) => this.executeOne(ctx, call, assistantMessage, termination),
      ctx.options.toolExecution === 'sequential' ? 'sequential' : 'parallel'
    );

    for (const toolRes of results) {
      toolResults.push(toolRes);
      ctx.state.messages.push(toolRes);
      await ctx.emitEvent({ type: 'message_start', message: toolRes });
      await ctx.emitEvent({ type: 'message_end', message: toolRes });
    }

    return { toolResults, shouldTerminate: termination.value };
  }

  private async executeOne(
    ctx: TurnContext,
    call: ToolCallContent,
    assistantMessage: AssistantMessage,
    termination: TerminationFlag
  ): Promise<ToolResultMessage & { terminate?: boolean }> {
    const { options, toolRegistry, emitEvent, signal, clock } = ctx;
    const toolOpId = `op_tool_${call.id}`;

    if (options.journal) {
      options.journal.append('operation_intent', {
        id: toolOpId,
        type: 'tool_call',
        intent: { name: call.name, arguments: call.arguments }
      });
    }

    if (signal?.aborted) {
      const abortedRes: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        isError: true,
        content: [{ type: 'text', text: 'Tool execution aborted by signal' }],
        timestamp: clock()
      };
      if (options.journal) {
        options.journal.append('operation_settlement', {
          id: toolOpId,
          type: 'tool_call',
          error: 'Tool execution aborted by signal',
          settlement: abortedRes
        });
        options.journal.append('tool_execution', abortedRes);
      }
      return abortedRes;
    }

    ctx.state.pendingToolCalls.add(call.id);
    await emitEvent({
      type: 'tool_execution_start',
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments
    });

    let toolRes: ToolResultMessage & { terminate?: boolean };
    try {
      let blocked = false;
      let blockReason = 'Tool execution blocked by gate';
      if (options.beforeToolCall) {
        const beforeRes = await options.beforeToolCall({
          assistantMessage,
          toolCall: call,
          args: call.arguments,
          context: { messages: ctx.state.messages }
        });
        if (beforeRes?.block) {
          blocked = true;
          blockReason = beforeRes.reason || blockReason;
          if (beforeRes.terminate) termination.value = true;
        }
      }

      if (blocked) {
        toolRes = {
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          isError: true,
          content: [{ type: 'text', text: blockReason }],
          timestamp: clock()
        };
      } else {
        toolRes = await toolRegistry.executeTool(
          call,
          signal,
          async (update) => {
            await emitEvent({
              type: 'tool_execution_update',
              toolCallId: call.id,
              partialResult: update
            });
          },
          { messages: ctx.state.messages }
        );
      }

      if (options.afterToolCall) {
        const afterRes = await options.afterToolCall({
          assistantMessage,
          toolCall: call,
          args: call.arguments,
          result: { content: toolRes.content, details: toolRes.details },
          isError: toolRes.isError ?? false
        });
        if (afterRes) {
          if (afterRes.content) toolRes.content = afterRes.content;
          if (afterRes.details !== undefined) toolRes.details = afterRes.details;
          if (afterRes.isError !== undefined) toolRes.isError = afterRes.isError;
          if (afterRes.terminate) termination.value = true;
        }
      }
    } catch (error) {
      termination.value = true;
      const message = error instanceof Error ? error.message : String(error);
      toolRes = {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        isError: true,
        terminate: true,
        content: [{ type: 'text', text: `Tool lifecycle error: ${message}` }],
        timestamp: clock()
      };
    } finally {
      ctx.state.pendingToolCalls.delete(call.id);
    }

    if (options.journal) {
      options.journal.append('operation_settlement', {
        id: toolOpId,
        type: 'tool_call',
        settlement: { content: toolRes.content, details: toolRes.details },
        error: toolRes.isError
          ? (toolRes.content?.[0] as any)?.text || 'Tool execution error'
          : undefined
      });
      options.journal.append('tool_execution', toolRes);
    }

    if (toolRes.terminate) termination.value = true;
    await emitEvent({
      type: 'tool_execution_end',
      toolCallId: call.id,
      result: toolRes.content
    });
    return toolRes;
  }
}
