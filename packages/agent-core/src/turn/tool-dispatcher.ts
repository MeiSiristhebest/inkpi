import {
  type AgentTool,
  type AssistantMessage,
  type ToolCallContent,
  type ToolResultMessage,
  type ToolUpdateOptions,
  assertJsonObject,
  assertJsonValue
} from '@inkpi/protocol';
import {
  CODEMODE_DEFAULTS,
  CODEMODE_TOOL_NAME,
  type CodemodeExecutionContext,
  getCodemodeToolOptions
} from '../codemode.js';
import { runWithConcurrency } from '../concurrency.js';
import { adoptMessage, commitJournal } from '../journal-commit.js';
import { type InterruptedToolRecoveryPlan, synthesizeInterruptedToolResult } from '../reducer/session-reducer.js';
import { toolReplayContractsMatch } from '../tool-replay-contract.js';
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

interface PreparedCall {
  call: ToolCallContent;
  tool?: AgentTool;
  declaration?: string;
  argumentsError?: string;
  blockReason?: string;
  error?: string;
  terminate?: boolean;
  recovery?: InterruptedToolRecoveryPlan;
}

interface InternalToolCall {
  parentToolCallId: string;
  maxResultBytes: number;
}

/**
 * 管线第三段：执行 assistant 消息中的工具调用。
 *
 * 批次先顺序完成参数校验与 `beforeToolCall` 门控。
 * 单个工具随后保留 invocationId → journal 意图登记 → 中断检查 →
 * `tool_execution_start` → 实际执行或拦截 →
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
  /** Recover only calls admitted by both historical and current tool contracts. */
  public async recover(ctx: TurnContext, plans: InterruptedToolRecoveryPlan[]): Promise<void> {
    const preparations: { prepared: PreparedCall; assistant: AssistantMessage; plan: InterruptedToolRecoveryPlan }[] =
      [];
    for (const original of plans) {
      const currentTools = ctx.currentTools?.() ?? ctx.toolRegistry;
      const refused =
        original.action === 'replay' &&
        (original.replay !== 'safe' ||
          currentTools.get(original.toolName)?.replay !== 'safe' ||
          !toolReplayContractsMatch(original.contract, currentTools.getReplayContract(original.toolName)) ||
          !currentTools.validateParameters(currentTools.get(original.toolName)!, original.arguments ?? {}).valid);
      const plan: InterruptedToolRecoveryPlan = refused
        ? { ...original, action: 'synthesize', reason: 'current-contract-refused' }
        : original;
      const call: ToolCallContent = {
        type: 'toolCall',
        id: plan.toolCallId ?? (plan.operationId.startsWith('op_tool_') ? plan.operationId.slice(8) : plan.operationId),
        name: plan.toolName,
        arguments: structuredClone(plan.arguments ?? {})
      };
      const assistant = [...ctx.state.messages]
        .reverse()
        .find(
          (message): message is AssistantMessage =>
            message.role === 'assistant' &&
            message.content.some((block) => block.type === 'toolCall' && block.id === call.id)
        ) ?? { role: 'assistant', content: [call], timestamp: ctx.clock() };
      const prepared = plan.action === 'replay' ? await this.prepareCall(ctx, call, assistant) : { call };
      preparations.push({ prepared: { ...prepared, recovery: plan }, assistant, plan });
    }
    const termination: TerminationFlag = { value: false };
    const results = await runWithConcurrency(
      preparations,
      async ({ prepared, assistant, plan }) => {
        if (plan.action === 'replay') return this.executeOne(ctx, prepared, assistant, termination, plan.sourceIndex);
        const synthetic = synthesizeInterruptedToolResult(plan, ctx.clock);
        return this.settleTool(
          ctx,
          prepared.call,
          synthetic,
          plan.invocationId,
          plan.sourceIndex,
          'Interrupted tool effect is unknown',
          plan.operationId
        );
      },
      ctx.options.toolExecution === 'sequential' ? 'sequential' : 'parallel'
    );
    for (const result of results) {
      adoptMessage(ctx.state, ctx.options.journal, result);
      await ctx.emitEvent({ type: 'message_start', message: result });
      await ctx.emitEvent({ type: 'message_end', message: result });
    }
  }

  /** 执行工具调用，并把结果消息并入会话历史。 */
  public async dispatch(ctx: TurnContext, assistantMessage: AssistantMessage): Promise<ToolDispatchResult> {
    const toolCalls = extractToolCalls(assistantMessage);
    const toolResults: ToolResultMessage[] = [];
    const termination: TerminationFlag = { value: false };

    if (toolCalls.length === 0) {
      return { toolResults, shouldTerminate: false };
    }
    const callIds = new Set<string>();
    for (const call of toolCalls) {
      if (!call.id || callIds.has(call.id)) throw new Error(`Duplicate or empty tool call identity '${call.id}'.`);
      callIds.add(call.id);
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
        const invalidArgumentsError = this.getJournalArgumentsError(ctx, call);
        let truncatedRes: ToolResultMessage = invalidArgumentsError
          ? await this.rejectInvalidArguments(ctx, call, invalidArgumentsError, sourceIndexByCallId.get(call.id))
          : {
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
        if (ctx.options.journal && !invalidArgumentsError) {
          // 截断拦截同样遵守"意图 → 结算 → 结果物化"三段持久化，保证恢复路径完整。
          const invocationId = this.reserveInvocationId(ctx);
          const toolOpId = `op_tool_${invocationId}`;
          await commitJournal(ctx.options.journal, [
            {
              type: 'operation_intent',
              payload: {
                id: toolOpId,
                type: 'tool_call',
                invocationId,
                replay: 'never',
                intent: {
                  name: call.name,
                  toolCallId: call.id,
                  ...(sourceIndexByCallId.get(call.id) !== undefined
                    ? { sourceIndex: sourceIndexByCallId.get(call.id) }
                    : {}),
                  arguments: call.arguments,
                  intercepted: 'output_length'
                }
              }
            }
          ]);
          truncatedRes = await this.settleTool(
            ctx,
            call,
            truncatedRes,
            invocationId,
            sourceIndexByCallId.get(call.id),
            'Intercepted: assistant response hit output limit before tool arguments completed.'
          );
        }
        toolResults.push(truncatedRes);
        adoptMessage(ctx.state, ctx.options.journal, truncatedRes);
        await ctx.emitEvent({ type: 'message_start', message: truncatedRes });
        await ctx.emitEvent({ type: 'message_end', message: truncatedRes });
      }
      return { toolResults, shouldTerminate: false };
    }

    const prepared: PreparedCall[] = [];
    for (const call of toolCalls) prepared.push(await this.prepareCall(ctx, call, assistantMessage));
    const results = await runWithConcurrency(
      prepared,
      (preparation) =>
        this.executeOne(ctx, preparation, assistantMessage, termination, sourceIndexByCallId.get(preparation.call.id)),
      ctx.options.toolExecution === 'sequential' ? 'sequential' : 'parallel'
    );

    for (const toolRes of results) {
      toolResults.push(toolRes);
      adoptMessage(ctx.state, ctx.options.journal, toolRes);
      await ctx.emitEvent({ type: 'message_start', message: toolRes });
      await ctx.emitEvent({ type: 'message_end', message: toolRes });
    }

    return { toolResults, shouldTerminate: termination.value };
  }

  /** 预保留调用身份（对齐上游 "invocationId = resultEntryId"：即未来 tool_execution 条目的 id）。 */
  private reserveInvocationId(ctx: TurnContext): string {
    if (ctx.options.idGenerator) {
      return ctx.options.idGenerator();
    }
    return `inv_${crypto.randomUUID()}`;
  }

  private async prepareCall(
    ctx: TurnContext,
    call: ToolCallContent,
    assistantMessage: AssistantMessage
  ): Promise<PreparedCall> {
    const preparation: PreparedCall = { call };
    preparation.argumentsError = this.getJournalArgumentsError(ctx, call);
    if (preparation.argumentsError) return preparation;
    if (ctx.signal?.aborted) return { call, blockReason: 'Tool execution aborted by signal' };
    const tool = ctx.toolRegistry.get(call.name);
    if (!tool) return { call, blockReason: `Tool '${call.name}' not found in registry` };
    const validation = ctx.toolRegistry.validateParameters(tool, call.arguments);
    if (!validation.valid) return { call, blockReason: `Parameter Validation Error: ${validation.error}` };
    preparation.tool = tool;
    preparation.declaration = this.toolDeclaration(ctx, call.name);
    try {
      const before = await ctx.options.beforeToolCall?.(
        {
          assistantMessage: structuredClone(assistantMessage),
          toolCall: structuredClone(call),
          args: structuredClone(call.arguments),
          context: { messages: structuredClone(ctx.state.messages) }
        },
        ctx.signal
      );
      if (before?.block) {
        preparation.blockReason = before.reason || 'Tool execution blocked by gate';
        preparation.terminate = before.terminate;
      }
    } catch (error) {
      preparation.error = error instanceof Error ? error.message : String(error);
      preparation.terminate = true;
    }
    return preparation;
  }

  private getJournalArgumentsError(ctx: TurnContext, call: ToolCallContent): string | undefined {
    if (!ctx.options.journal) return undefined;
    try {
      assertJsonObject(call.arguments, `Tool '${call.name}' arguments`);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private async rejectInvalidArguments(
    ctx: TurnContext,
    call: ToolCallContent,
    error: string,
    sourceIndex?: number
  ): Promise<ToolResultMessage> {
    const { options, emitEvent, clock } = ctx;
    const invocationId = this.reserveInvocationId(ctx);
    const toolOpId = `op_tool_${invocationId}`;
    const errorText = `Tool arguments rejected before execution: ${error}`;
    let result: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      isError: true,
      content: [{ type: 'text', text: errorText }],
      timestamp: clock()
    };

    if (options.journal) {
      await commitJournal(options.journal, [
        {
          type: 'operation_intent',
          payload: {
            id: toolOpId,
            type: 'tool_call',
            invocationId,
            replay: 'never',
            intent: {
              name: call.name,
              toolCallId: call.id,
              ...(sourceIndex !== undefined ? { sourceIndex } : {}),
              invalidArguments: true
            }
          }
        }
      ]);
    }

    ctx.state.pendingToolCalls.add(call.id);
    try {
      await emitEvent({
        type: 'tool_execution_start',
        toolCallId: call.id,
        toolName: call.name,
        args: {}
      });

      if (options.journal) {
        result = await this.settleTool(ctx, call, result, invocationId, sourceIndex, errorText);
      }

      await emitEvent({
        type: 'tool_execution_end',
        toolCallId: call.id,
        result: result.content
      });
      return result;
    } finally {
      ctx.state.pendingToolCalls.delete(call.id);
    }
  }

  private async executeOne(
    ctx: TurnContext,
    preparation: PreparedCall,
    assistantMessage: AssistantMessage,
    termination: TerminationFlag,
    sourceIndex?: number,
    internal?: InternalToolCall
  ): Promise<ToolResultMessage & { terminate?: boolean }> {
    const { options, toolRegistry, emitEvent, signal, clock } = ctx;
    const { call } = preparation;
    const invalidArgumentsError = preparation.argumentsError;

    if (invalidArgumentsError) {
      return this.rejectInvalidArguments(ctx, call, invalidArgumentsError, sourceIndex);
    }

    const invocationId = preparation.recovery?.invocationId ?? this.reserveInvocationId(ctx);
    const operationType = internal ? 'codemode_read' : 'tool_call';
    const toolOpId =
      preparation.recovery?.operationId ?? `${internal ? 'op_codemode_read' : 'op_tool'}_${invocationId}`;
    const replay =
      internal || preparation.blockReason || preparation.error || signal?.aborted
        ? 'never'
        : (toolRegistry.get(call.name)?.replay ?? 'never');
    const contract = toolRegistry.getReplayContract(call.name);
    if (options.journal && !preparation.recovery) {
      await commitJournal(options.journal, [
        {
          type: 'operation_intent',
          payload: {
            id: toolOpId,
            type: operationType,
            invocationId,
            replay,
            intent: {
              name: call.name,
              toolCallId: call.id,
              arguments: call.arguments,
              ...(internal ? { visibility: 'internal', parentToolCallId: internal.parentToolCallId } : {}),
              ...(sourceIndex !== undefined ? { sourceIndex } : {}),
              ...(contract ? { contract } : {})
            }
          }
        }
      ]);
    }

    if (signal?.aborted) {
      let abortedRes: ToolResultMessage = {
        role: 'toolResult',
        toolCallId: call.id,
        toolName: call.name,
        isError: true,
        content: [{ type: 'text', text: 'Tool execution aborted by signal' }],
        timestamp: clock()
      };
      if (options.journal) {
        abortedRes = internal
          ? await this.settleInternalTool(
              ctx,
              call,
              abortedRes,
              invocationId,
              'Tool execution aborted by signal',
              toolOpId,
              internal.parentToolCallId
            )
          : await this.settleTool(
              ctx,
              call,
              abortedRes,
              invocationId,
              sourceIndex,
              'Tool execution aborted by signal',
              toolOpId
            );
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
    let pendingUpdateEvents = Promise.resolve();
    let updateError: unknown;
    const fencedUpdate = (update: { content: any[]; details?: unknown }, updateOptions?: ToolUpdateOptions): void => {
      if (settled) return;
      // checkpoint：工具显式请求把"完整有界"快照持久化为 tool_progress 条目。
      // 该条目仅是观察数据，绝不作为完成证明；节流与有界性由工具负责（可信工具合约）。
      const checkpoint = updateOptions?.checkpoint && options.journal;
      if (checkpoint) {
        assertJsonValue(update.content, `Tool '${call.name}' progress content`);
        if (update.details !== undefined) {
          assertJsonValue(update.details, `Tool '${call.name}' progress details`);
        }
      }
      const event = {
        type: 'tool_execution_update',
        toolCallId: call.id,
        partialResult: update
      } as const;
      pendingUpdateEvents = pendingUpdateEvents
        .then(async () => {
          if (checkpoint)
            await commitJournal(options.journal, [
              {
                type: 'tool_progress',
                payload: {
                  invocationId,
                  toolCallId: call.id,
                  toolName: call.name,
                  snapshot: {
                    content: update.content,
                    ...(update.details !== undefined ? { details: update.details } : {})
                  },
                  timestamp: clock()
                }
              }
            ]);
          await emitEvent(event);
        })
        .catch((error) => {
          updateError ??= error;
        });
    };

    let toolRes: ToolResultMessage & { terminate?: boolean };
    let executedDuration: number | undefined;
    try {
      if (preparation.terminate) termination.value = true;
      if (preparation.error) throw new Error(preparation.error);
      let blockReason = preparation.blockReason;
      const current = (ctx.currentTools?.() ?? toolRegistry).get(call.name);
      if (
        !blockReason &&
        (current !== preparation.tool || this.toolDeclaration(ctx, call.name) !== preparation.declaration)
      )
        blockReason = 'Tool registration changed during preflight';
      if (blockReason) {
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
          fencedUpdate,
          this.executionContext(ctx, assistantMessage, preparation.tool ?? toolRegistry.get(call.name))
        );
        executedDuration = toolRes.durationMs;
      }

      if (options.afterToolCall) {
        const afterRes = await options.afterToolCall(
          {
            assistantMessage,
            toolCall: call,
            args: call.arguments,
            result: { content: toolRes.content, details: toolRes.details },
            isError: toolRes.isError ?? false
          },
          signal
        );
        if (afterRes) {
          if (afterRes.content) toolRes.content = afterRes.content;
          if (afterRes.details !== undefined) toolRes.details = afterRes.details;
          if (afterRes.isError !== undefined) toolRes.isError = afterRes.isError;
          if (afterRes.terminate) termination.value = true;
        }
      }

      if (internal) toolRes = this.boundInternalResult(toolRes, internal.maxResultBytes);

      if (options.journal) {
        assertJsonValue(toolRes.content, `Tool '${call.name}' result content`);
        if (toolRes.details !== undefined) {
          assertJsonValue(toolRes.details, `Tool '${call.name}' result details`);
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
        ...(executedDuration !== undefined ? { durationMs: executedDuration } : {}),
        content: [{ type: 'text', text: `Tool lifecycle error: ${message}` }],
        timestamp: clock()
      };
    } finally {
      settled = true;
      await pendingUpdateEvents;
      ctx.state.pendingToolCalls.delete(call.id);
    }
    if (updateError) throw updateError;

    if (options.journal) {
      const error = toolRes.isError
        ? (toolRes.content?.[0] as { text?: string })?.text || 'Tool execution error'
        : undefined;
      toolRes = internal
        ? await this.settleInternalTool(ctx, call, toolRes, invocationId, error, toolOpId, internal.parentToolCallId)
        : await this.settleTool(ctx, call, toolRes, invocationId, sourceIndex, error, toolOpId);
    }

    if (toolRes.terminate) termination.value = true;
    await emitEvent({
      type: 'tool_execution_end',
      toolCallId: call.id,
      ...(toolRes.durationMs !== undefined ? { durationMs: toolRes.durationMs } : {}),
      result: toolRes.content
    });
    return toolRes;
  }

  private executionContext(ctx: TurnContext, assistantMessage: AssistantMessage, tool: AgentTool | undefined): unknown {
    const context: { messages: typeof ctx.state.messages; codemode?: CodemodeExecutionContext } = {
      messages: ctx.state.messages
    };
    const codeModeOptions = tool ? getCodemodeToolOptions(tool) : undefined;
    if (!codeModeOptions) return context;

    const registry = ctx.currentTools?.() ?? ctx.toolRegistry;
    const allowed = new Set(codeModeOptions.allowedReadTools);
    const tools = codeModeOptions.allowedReadTools.flatMap((name) => {
      const candidate = registry.get(name);
      const registration = registry.getRegistration(name);
      if (
        !candidate ||
        !registration ||
        registration.capabilities.length !== 1 ||
        registration.capabilities[0] !== 'read'
      )
        return [];
      return [{ name, description: candidate.description }];
    });
    const parentToolCallId =
      assistantMessage.content.find(
        (item): item is ToolCallContent => item.type === 'toolCall' && item.name === CODEMODE_TOOL_NAME
      )?.id ?? 'codemode';
    context.codemode = {
      tools,
      executeReadTool: async (name, args, signal) => {
        if (!allowed.has(name)) throw new Error(`Tool '${name}' is not allowlisted for codemode.`);
        if (name === CODEMODE_TOOL_NAME) throw new Error('Codemode cannot call itself.');
        const currentRegistry = ctx.currentTools?.() ?? ctx.toolRegistry;
        const candidate = currentRegistry.get(name);
        const registration = currentRegistry.getRegistration(name);
        if (
          !candidate ||
          !registration ||
          registration.capabilities.length !== 1 ||
          registration.capabilities[0] !== 'read'
        ) {
          throw new Error(`Tool '${name}' is not registered with the read-only capability.`);
        }
        try {
          assertJsonObject(args, `Codemode tool '${name}' arguments`);
        } catch (error) {
          throw new Error(error instanceof Error ? error.message : String(error));
        }

        const nestedContext: TurnContext = { ...ctx, toolRegistry: currentRegistry, signal };
        const nestedCall: ToolCallContent = {
          type: 'toolCall',
          id: `codemode_${this.reserveInvocationId(nestedContext)}`,
          name,
          arguments: structuredClone(args)
        };
        const preparation = await this.prepareCall(nestedContext, nestedCall, assistantMessage);
        const result = await this.executeOne(
          nestedContext,
          preparation,
          assistantMessage,
          { value: false },
          undefined,
          {
            parentToolCallId,
            maxResultBytes: CODEMODE_DEFAULTS.maxNestedResultBytes
          }
        );
        if (result.isError || result.terminate) {
          const errorText = result.content
            .map((item) => (item.type === 'text' ? item.text : ''))
            .filter(Boolean)
            .join('\n');
          throw new Error(errorText || `Tool '${name}' failed.`);
        }
        return {
          content: result.content,
          ...(result.details !== undefined ? { details: result.details } : {})
        };
      }
    };
    return context;
  }

  private boundInternalResult<T extends ToolResultMessage>(result: T, maxBytes: number): T {
    let encoded: string;
    try {
      encoded = JSON.stringify({
        content: result.content,
        ...(result.details !== undefined ? { details: result.details } : {})
      });
    } catch {
      return {
        ...result,
        isError: true,
        details: undefined,
        content: [{ type: 'text', text: 'Nested tool result is not JSON serializable.' }]
      };
    }
    if (new TextEncoder().encode(encoded).byteLength <= maxBytes) return result;
    return {
      ...result,
      isError: true,
      details: undefined,
      content: [{ type: 'text', text: `Nested tool result exceeds ${maxBytes} bytes.` }]
    };
  }

  private async settleInternalTool<T extends ToolResultMessage>(
    ctx: TurnContext,
    call: ToolCallContent,
    result: T,
    invocationId: string,
    error: string | undefined,
    operationId: string,
    parentToolCallId: string
  ): Promise<T> {
    await commitJournal(ctx.options.journal, [
      {
        type: 'operation_settlement',
        payload: {
          id: operationId,
          type: 'codemode_read',
          invocationId,
          error,
          settlement: {
            visibility: 'internal',
            parentToolCallId,
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
            ...(result.details !== undefined ? { details: result.details } : {})
          }
        }
      }
    ]);
    return result;
  }

  private async settleTool<T extends ToolResultMessage>(
    ctx: TurnContext,
    call: ToolCallContent,
    result: T,
    invocationId: string,
    sourceIndex?: number,
    error?: string,
    operationId = `op_tool_${invocationId}`
  ): Promise<T> {
    const { details, ...message } = result;
    const entries = await commitJournal(ctx.options.journal, [
      {
        type: 'operation_settlement',
        payload: {
          id: operationId,
          type: 'tool_call',
          invocationId,
          error,
          settlement: { content: result.content, ...(result.details !== undefined ? { details: result.details } : {}) }
        }
      },
      {
        type: 'tool_execution',
        id: invocationId,
        payload: {
          ...message,
          ...(details !== undefined ? { details } : {}),
          invocationId,
          ...(sourceIndex !== undefined ? { sourceIndex } : {})
        }
      }
    ]);
    const entry = entries[entries.length - 1];
    return entry ? { ...result, id: entry.id } : result;
  }

  private toolDeclaration(ctx: TurnContext, name: string): string {
    const tools = ctx.currentTools?.() ?? ctx.toolRegistry;
    const tool = tools.get(name);
    return JSON.stringify({
      description: tool?.description,
      parameters: tool?.parameters,
      replay: tool?.replay ?? 'never',
      contract: tools.getReplayContract(name)
    });
  }
}
