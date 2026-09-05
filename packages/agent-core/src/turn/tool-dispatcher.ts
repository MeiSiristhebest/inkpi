import type { AssistantMessage, ToolCallContent, ToolResultMessage, ToolUpdateOptions } from '@inkpi/protocol';
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
 * 单个工具的生命周期为：预保留 invocationId → journal 意图登记 → 中断检查 →
 * `tool_execution_start` → `beforeToolCall` 门控 → 实际执行或拦截 →
 * `afterToolCall` 覆写 → journal 结算 → `tool_execution_end`。
 * 并发策略由 `options.toolExecution` 决定，统一走 `runWithConcurrency`。
 *
 * 持久性合约（对齐上游 pi v0.85.x tool-durability）：
 * - **意图先行**：effect 执行前先写 `operation_intent`（含预保留 invocationId 与 replay 策略）；
 * - **结算即持久化**：每个工具 settle 后立即写 `operation_settlement` 与 `tool_execution`，
 *   不等待批次其他调用；
 * - **源序放置**：`tool_execution` 条目携带 `sourceIndex`（assistant content 中的块下标），
 *   journal 追加顺序是完成序，恢复归约时按 sourceIndex 重排物化；
 * - **fencing**：结算后拒收迟到的进度更新；
 * - **replay 合约**：`replay: 'never'` 的工具中断后绝不重跑，恢复方必须合成占位结果。
 */
export class ToolDispatcher {
  /** 执行工具调用，并把结果消息并入会话历史。 */
  public async dispatch(ctx: TurnContext, assistantMessage: AssistantMessage): Promise<ToolDispatchResult> {
    const toolCalls = extractToolCalls(assistantMessage);
    const toolResults: ToolResultMessage[] = [];
    const termination: TerminationFlag = { value: false };

    if (toolCalls.length === 0) {
      return { toolResults, shouldTerminate: false };
    }

    // 源序映射：toolCallContent 块在 assistant content 中的下标。
    // journal 按完成序追加，恢复归约依赖此下标重排为源序（对齐上游 tool-durability placement）。
    const sourceIndexByCallId = new Map<string, number>();
    assistantMessage.content.forEach((block, index) => {
      if (block.type === 'toolCall') sourceIndexByCallId.set(block.id, index);
    });

    // 对齐上游 v0.85.0 PR #8845 / Commit e26afb6：如果模型回复因达到最大长度 (length) 截断，
    // 其工具参数可能不完整，不予执行截断工具调用，避免产生未知副作用。
    if (assistantMessage.stopReason === 'length') {
      for (const call of toolCalls) {
        const truncatedRes: ToolResultMessage = {
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          isError: true,
          content: [
            {
              type: 'text',
              text: `Tool call '${call.name}' was not executed because the assistant response hit the output token limit and arguments may be truncated.`
            }
          ],
          timestamp: ctx.clock()
        };
        if (ctx.options.journal) {
          // 截断拦截同样遵守"意图 → 结算 → 结果物化"三段持久化，保证恢复路径完整。
          const invocationId = this.reserveInvocationId(ctx);
          const toolOpId = `op_tool_${call.id}`;
          ctx.options.journal.append('operation_intent', {
            id: toolOpId,
            type: 'tool_call',
            invocationId,
            replay: 'never',
            intent: { name: call.name, arguments: call.arguments, intercepted: 'output_length' }
          });
          ctx.options.journal.append('operation_settlement', {
            id: toolOpId,
            type: 'tool_call',
            invocationId,
            settlement: { content: truncatedRes.content },
            error: 'Intercepted: assistant response hit output limit before tool arguments completed.'
          });
          ctx.options.journal.append(
            'tool_execution',
            { ...truncatedRes, invocationId, sourceIndex: sourceIndexByCallId.get(call.id) },
            invocationId
          );
        }
        toolResults.push(truncatedRes);
        ctx.state.messages.push(truncatedRes);
        await ctx.emitEvent({ type: 'message_start', message: truncatedRes });
        await ctx.emitEvent({ type: 'message_end', message: truncatedRes });
      }
      return { toolResults, shouldTerminate: false };
    }

    const results = await runWithConcurrency(
      toolCalls,
      (call) => this.executeOne(ctx, call, assistantMessage, termination, sourceIndexByCallId.get(call.id)),
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

  /** 预保留调用身份（对齐上游 "invocationId = resultEntryId"：即未来 tool_execution 条目的 id）。 */
  private reserveInvocationId(ctx: TurnContext): string {
    return `inv_${ctx.clock()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  private async executeOne(
    ctx: TurnContext,
    call: ToolCallContent,
    assistantMessage: AssistantMessage,
    termination: TerminationFlag,
    sourceIndex?: number
  ): Promise<ToolResultMessage & { terminate?: boolean }> {
    const { options, toolRegistry, emitEvent, signal, clock } = ctx;
    const toolOpId = `op_tool_${call.id}`;
    const invocationId = this.reserveInvocationId(ctx);
    const replay = toolRegistry.get(call.name)?.replay ?? 'safe';

    if (options.journal) {
      options.journal.append('operation_intent', {
        id: toolOpId,
        type: 'tool_call',
        invocationId,
        replay,
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
          invocationId,
          error: 'Tool execution aborted by signal',
          settlement: abortedRes
        });
        options.journal.append('tool_execution', { ...abortedRes, invocationId, sourceIndex }, invocationId);
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

    // fencing：结算后拒收迟到的进度更新（对齐上游 tool-durability "tool-promise settlement
    // stops accepting updates"）。
    let settled = false;
    const fencedUpdate = async (update: { content: any[]; details?: unknown }, updateOptions?: ToolUpdateOptions) => {
      if (settled) return;
      // checkpoint：工具显式请求把"完整有界"快照持久化为 tool_progress 条目。
      // 该条目仅是观察数据，绝不作为完成证明；节流与有界性由工具负责（可信工具合约）。
      if (updateOptions?.checkpoint && options.journal) {
        options.journal.append('tool_progress', {
          invocationId,
          toolCallId: call.id,
          toolName: call.name,
          snapshot: { content: update.content, details: update.details },
          timestamp: clock()
        });
      }
      await emitEvent({
        type: 'tool_execution_update',
        toolCallId: call.id,
        partialResult: update
      });
    };

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
        toolRes = await toolRegistry.executeTool(call, signal, fencedUpdate, { messages: ctx.state.messages });
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
      settled = true;
      ctx.state.pendingToolCalls.delete(call.id);
    }

    if (options.journal) {
      options.journal.append('operation_settlement', {
        id: toolOpId,
        type: 'tool_call',
        invocationId,
        settlement: { content: toolRes.content, details: toolRes.details },
        error: toolRes.isError ? (toolRes.content?.[0] as any)?.text || 'Tool execution error' : undefined
      });
      // tool_execution 条目 id = invocationId（预保留的结果条目身份，重放安全）。
      options.journal.append('tool_execution', { ...toolRes, invocationId, sourceIndex }, invocationId);
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
