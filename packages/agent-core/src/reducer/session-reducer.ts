/**
 * Pure Function SessionReducer
 * 接收 SessionEntry[] 日志流，纯函数计算物化会话状态 (MaterializedSessionState)。
 */

import { mergeOperationIntent } from '@inkpi/protocol';
import type {
  AgentMessage,
  AssistantMessage,
  JournalEntry,
  OperationRecord,
  OperationState,
  RuntimeState,
  SessionEntry,
  ToolResultMessage,
  Usage,
  UserMessage
} from '@inkpi/protocol';
import type { WorkflowStateAdapter } from '@inkpi/protocol';
import { genericRuntimeStateAdapter } from '../pipeline/ledger-merge.js';
import { toolReplayContractsMatch } from '../tool-replay-contract.js';
import type { ToolRegistry } from '../tools.js';
import type { AssistantStreamFrame } from '../turn/assistant-frames.js';
import { reduceAssistantFrames } from '../turn/assistant-frames.js';

/** State merge contract supplied by the composition root. */
export type SessionStateAdapter<TState extends RuntimeState = RuntimeState> = WorkflowStateAdapter<TState>;

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface MaterializedSessionState<TState extends RuntimeState = RuntimeState> {
  sessionId: string;
  currentLeafId: string | null;
  activeLaneId: string;
  messages: AgentMessage[];
  operations: Map<string, OperationRecord>;
  usageTotals: TokenUsageSummary;
  /** Canonical opaque state. Runtime does not inspect its product-domain shape. */
  runtimeState: TState;
  /** @deprecated Compatibility alias for runtimeState; it is not a StateLedger. */
  factsLedger: TState;
  revisions: Map<string, number>;
  /**
   * 源序放置缓冲（对齐上游 pi tool-durability 的 outcome_ready → completed 两阶段）：
   * journal 里的 tool_execution 按**完成序**追加，归约时先入缓冲，
   * 遇到下一条非工具结果条目（或归约结束）时按 sourceIndex 重排后一次性物化。
   */
  pendingToolResults: Array<{ message: ToolResultMessage; sourceIndex?: number }>;
  /** 助手流式帧缓冲：`agent_turn` 结算落地即清空；归约结束仍有残留则重建部分消息。 */
  pendingAssistantFrames: AssistantStreamFrame[];
}

/** Owned snapshots are read-only by convention; custom adapters receive a mutable copy. */
function mergeOwnedState<TState extends RuntimeState>(
  adapter: SessionStateAdapter<TState>,
  state: TState,
  patch: unknown
): TState {
  return adapter.merge(adapter === genericRuntimeStateAdapter ? state : structuredClone(state), structuredClone(patch));
}

function resolveStateAdapter<TState extends RuntimeState>(
  stateAdapter?: SessionStateAdapter<TState>
): SessionStateAdapter<TState> {
  return stateAdapter ?? (genericRuntimeStateAdapter as SessionStateAdapter<TState>);
}

export function createInitialSessionState<TState extends RuntimeState = RuntimeState>(
  sessionId = 'default',
  stateAdapter?: SessionStateAdapter<TState>
): MaterializedSessionState<TState> {
  const runtimeState = structuredClone(resolveStateAdapter(stateAdapter).createInitialState());
  return {
    sessionId,
    currentLeafId: null,
    activeLaneId: 'main',
    messages: [],
    operations: new Map(),
    usageTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    },
    runtimeState,
    factsLedger: runtimeState,
    revisions: new Map(),
    pendingToolResults: [],
    pendingAssistantFrames: []
  };
}

/**
 * 源序放置：把缓冲中的工具结果按 sourceIndex 稳定排序后物化进 messages。
 *
 * - 缺少 sourceIndex 的旧条目排在有下标条目之后，组内保持 journal（完成）序——
 *   与升级前的行为完全一致，旧日志零回归；
 * - 纯函数：返回新快照，不修改入参。
 */
function flushPendingToolResults<TState extends RuntimeState>(
  state: MaterializedSessionState<TState>
): MaterializedSessionState<TState> {
  if (state.pendingToolResults.length === 0) return state;
  const ordered = state.pendingToolResults
    .map((item, order) => ({ item, order }))
    .sort((a, b) => {
      const ai = a.item.sourceIndex ?? Number.MAX_SAFE_INTEGER;
      const bi = b.item.sourceIndex ?? Number.MAX_SAFE_INTEGER;
      return ai === bi ? a.order - b.order : ai - bi;
    })
    .map(({ item }) => item.message);
  return { ...state, messages: [...state.messages, ...ordered], pendingToolResults: [] };
}

/**
 * 纯函数归约单条 SessionEntry
 */
export function reduceSessionEntry<TState extends RuntimeState = RuntimeState>(
  state: MaterializedSessionState<TState>,
  entry: SessionEntry | JournalEntry,
  stateAdapter?: SessionStateAdapter<TState>
): MaterializedSessionState<TState> {
  const adapter = resolveStateAdapter(stateAdapter);
  const runtimeState = state.runtimeState ?? state.factsLedger ?? structuredClone(adapter.createInitialState());
  const next: MaterializedSessionState<TState> = {
    ...state,
    messages: [...state.messages],
    operations: new Map(state.operations),
    usageTotals: { ...state.usageTotals },
    runtimeState,
    factsLedger: runtimeState,
    revisions: new Map(state.revisions),
    pendingToolResults: [...state.pendingToolResults],
    pendingAssistantFrames: [...state.pendingAssistantFrames]
  };

  if (!next.sessionId && entry.sessionId) {
    next.sessionId = entry.sessionId;
  }
  if (entry.laneId) {
    next.activeLaneId = entry.laneId;
  }
  next.currentLeafId = entry.id;

  // 源序放置：工具结果只在遇到下一条"会话推进"条目（或归约结束）时才物化。
  if (
    entry.type === 'user_message' ||
    entry.type === 'agent_turn' ||
    entry.type === 'compaction' ||
    entry.type === 'custom'
  ) {
    const flushed = flushPendingToolResults(next);
    next.messages = flushed.messages;
    next.pendingToolResults = flushed.pendingToolResults;
  }

  switch (entry.type) {
    case 'session_start': {
      if (entry.payload?.laneId) {
        next.activeLaneId = entry.payload.laneId;
      }
      break;
    }

    case 'user_message': {
      const userMsg = messageFromSessionEntry(entry) as UserMessage;
      next.messages.push(userMsg);
      break;
    }

    case 'agent_turn': {
      const payload = entry.payload;
      const assistantMsg = messageFromSessionEntry(entry) as AssistantMessage;
      next.messages.push(assistantMsg);

      if (payload?.usage) {
        const u = payload.usage as Usage;
        next.usageTotals.inputTokens += u.inputTokens || 0;
        next.usageTotals.outputTokens += u.outputTokens || 0;
        next.usageTotals.totalTokens += u.totalTokens || 0;
      }

      // 助手消息终态落地：流式帧的使命结束，原子丢弃（对齐上游 assistant-durability
      // "delete all partial frames atomically with response settlement"）。
      next.pendingAssistantFrames = [];
      break;
    }

    case 'tool_execution': {
      const payload = entry.payload;
      const toolMsg = messageFromSessionEntry(entry) as ToolResultMessage;
      // 源序放置：journal 是完成序，先入缓冲，等待重排物化（见 flushPendingToolResults）。
      const sourceIndex = typeof payload?.sourceIndex === 'number' ? payload.sourceIndex : undefined;
      next.pendingToolResults.push({ message: toolMsg, sourceIndex });
      break;
    }

    case 'assistant_frame': {
      // 流式帧缓冲：仅是进行中快照的观察数据，不进 messages（对齐上游
      // "base restore does not read it"——base 物化不依赖帧，归约结束时才重建残留部分消息）。
      const frame = entry.payload?.frame;
      if (frame && typeof frame === 'object' && typeof frame.type === 'string') {
        next.pendingAssistantFrames.push(structuredClone(frame));
      }
      break;
    }

    case 'operation_intent': {
      const op = structuredClone(entry.payload);
      if (op && typeof op.id === 'string') {
        const existing = next.operations.get(op.id);
        const storedIntent = mergeOperationIntent(op);
        next.operations.set(op.id, {
          id: op.id,
          sessionId: next.sessionId,
          type: op.type || 'custom',
          state: (op.state as OperationState) || 'running',
          intent: storedIntent,
          error: op.error,
          createdAt: existing?.createdAt || entry.timestamp,
          updatedAt: entry.timestamp
        });
      }
      break;
    }

    case 'operation_settlement': {
      const op = structuredClone(entry.payload);
      if (op && typeof op.id === 'string') {
        const existing = next.operations.get(op.id);
        const isError = Boolean(op.error);
        next.operations.set(op.id, {
          id: op.id,
          sessionId: next.sessionId,
          type: op.type || existing?.type || 'custom',
          state: isError ? 'failed' : 'settled',
          intent: existing?.intent ?? op.intent,
          settlement: op.settlement !== undefined ? op.settlement : op.result,
          error: op.error || undefined,
          createdAt: existing?.createdAt || entry.timestamp,
          updatedAt: entry.timestamp
        });
      }
      break;
    }

    case 'ledger_mutation': {
      const payload = entry.payload;
      // `statePatch` is the generic envelope. `ledger` remains a wire-level
      // compatibility alias and is not interpreted as a product-domain type.
      const statePatch =
        isRecord(payload) && 'statePatch' in payload
          ? payload.statePatch
          : isRecord(payload) && 'ledger' in payload
            ? payload.ledger
            : payload;
      if (isRecord(statePatch)) {
        next.runtimeState = mergeOwnedState(adapter, next.runtimeState, statePatch);
        next.factsLedger = next.runtimeState;
      }
      break;
    }

    case 'draft_revision': {
      const docId = entry.payload?.documentId;
      const ver = entry.payload?.version;
      if (typeof docId === 'string' && typeof ver === 'number') {
        next.revisions.set(docId, ver);
      }
      break;
    }

    case 'compaction': {
      const summary = entry.payload?.summary;
      if (summary) {
        next.runtimeState = mergeOwnedState(adapter, next.runtimeState, { _lastCompactionSummary: summary });
        next.factsLedger = next.runtimeState;
      }
      break;
    }

    case 'custom': {
      const message = messageFromSessionEntry(entry);
      if (message) next.messages.push(message);
      break;
    }

    default:
      break;
  }

  return next;
}

/** Normalize legacy payloads while preserving all settled message metadata. */
export function messageFromSessionEntry(entry: SessionEntry): AgentMessage | undefined {
  const payload = entry.payload;
  const identity = { id: entry.id, timestamp: entry.timestamp };
  if (entry.type === 'user_message')
    return {
      ...identity,
      role: 'user',
      content: typeof payload === 'string' ? payload : structuredClone(payload?.content ?? payload?.text ?? '')
    };
  if (entry.type === 'agent_turn')
    return {
      ...identity,
      role: 'assistant',
      content: Array.isArray(payload?.content)
        ? structuredClone(payload.content)
        : [{ type: 'text', text: payload?.content || payload?.text || '' }],
      stopReason: payload?.stopReason || 'stop',
      ...(payload?.errorMessage !== undefined ? { errorMessage: payload.errorMessage } : {}),
      ...(payload?.providerError !== undefined ? { providerError: structuredClone(payload.providerError) } : {}),
      ...(payload?.providerThinkingLevel !== undefined ? { providerThinkingLevel: payload.providerThinkingLevel } : {}),
      ...(payload?.usage !== undefined ? { usage: structuredClone(payload.usage) } : {}),
      ...(typeof payload?.durationMs === 'number' ? { durationMs: payload.durationMs } : {})
    };
  if (entry.type === 'tool_execution')
    return {
      ...identity,
      role: 'toolResult',
      toolCallId: payload?.toolCallId || payload?.id || entry.id,
      toolName: payload?.toolName || payload?.name || 'unknown_tool',
      content: Array.isArray(payload?.content)
        ? structuredClone(payload.content)
        : [
            {
              type: 'text',
              text: typeof payload?.result === 'string' ? payload.result : JSON.stringify(payload?.result || '')
            }
          ],
      ...(payload?.details !== undefined ? { details: structuredClone(payload.details) } : {}),
      isError: Boolean(payload?.isError || payload?.error),
      ...(typeof payload?.durationMs === 'number' ? { durationMs: payload.durationMs } : {})
    };
  if (entry.type === 'custom' && (payload?.role === 'custom' || payload?.role === 'system'))
    return { ...structuredClone(payload), ...identity };
  return undefined;
}

/**
 * 纯函数：全量归约 SessionEntry 日志列表
 */
export function reduceSession<TState extends RuntimeState = RuntimeState>(
  entries: (SessionEntry | JournalEntry)[],
  initialState?: MaterializedSessionState<TState>,
  stateAdapter?: SessionStateAdapter<TState>
): MaterializedSessionState<TState> {
  const adapter = resolveStateAdapter(stateAdapter);
  const base = initialState
    ? normalizeInitialState(structuredClone(initialState), adapter)
    : createInitialSessionState(entries[0]?.sessionId || 'default', adapter);

  const reduced = entries.reduce((state, entry) => reduceSessionEntry(state, entry, adapter), base);

  // 归约结束：物化仍在缓冲中的工具结果（源序）。
  const settled = flushPendingToolResults(reduced);

  // 崩溃时流未结算：从持久化帧重建部分助手消息，避免进行中输出对恢复方完全不可见。
  // 帧缺失时返回 null——"缺失合法"，不据此断言任何失败（对齐上游 assistant-durability）。
  if (settled.pendingAssistantFrames.length > 0) {
    const partial = reduceAssistantFrames(settled.pendingAssistantFrames);
    if (partial) {
      return {
        ...settled,
        messages: [...settled.messages, partial],
        pendingAssistantFrames: []
      };
    }
  }
  return settled;
}

/**
 * 查找并修正悬挂未完成的 operation (Crash Recovery)。
 *
 * 纯函数：**不修改入参**。返回值中的 `state` 是携带修复后 operations 的新快照；
 * 被标记的 OperationRecord 是全新对象，未受影响的记录按写时复制约定保持共享
 * （全仓无处原地改写记录，故共享是安全的）。不可变契约见 MaterializedSessionState。
 */
export function detectAndMarkInterruptedOperations(
  state: MaterializedSessionState,
  clock: () => number
): {
  state: MaterializedSessionState;
  recoveredCount: number;
  interruptedIds: string[];
} {
  const interruptedIds: string[] = [];
  const operations = new Map<string, OperationRecord>();
  const durableToolResults = new Map(
    state.messages
      .filter((message): message is ToolResultMessage => message.role === 'toolResult' && Boolean(message.id))
      .map((message) => [message.id, message])
  );
  for (const [id, op] of state.operations.entries()) {
    const intent = isRecord(op.intent) ? op.intent : {};
    const result = typeof intent.invocationId === 'string' ? durableToolResults.get(intent.invocationId) : undefined;
    if (op.type === 'tool_call' && result && ['running', 'pending', 'interrupted'].includes(op.state)) {
      operations.set(id, {
        ...op,
        state: result.isError ? 'failed' : 'settled',
        settlement: { content: result.content, ...(result.details !== undefined ? { details: result.details } : {}) },
        updatedAt: result.timestamp ?? op.updatedAt
      });
      continue;
    }
    if (op.state === 'running' || op.state === 'pending') {
      interruptedIds.push(id);
      operations.set(id, {
        ...op,
        state: 'interrupted',
        error: 'Operation interrupted by system shutdown/crash.',
        updatedAt: clock()
      });
    } else {
      operations.set(id, op);
    }
  }
  return {
    state: { ...state, operations },
    recoveredCount: interruptedIds.length,
    interruptedIds
  };
}

function normalizeInitialState<TState extends RuntimeState>(
  state: MaterializedSessionState<TState>,
  adapter: SessionStateAdapter<TState>
): MaterializedSessionState<TState> {
  const runtimeState = state.runtimeState ?? state.factsLedger ?? adapter.createInitialState();
  return { ...state, runtimeState, factsLedger: runtimeState };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 单个被中断工具调用的恢复决策（对齐上游 pi tool-durability 的 replay 合约）。 */
export interface InterruptedToolRecoveryPlan {
  /** 预保留的调用身份（tool_execution 条目 id），重放时必须复用。 */
  invocationId: string;
  /** Independent operation identity recorded by operation_intent. */
  operationId: string;
  toolCallId?: string;
  sourceIndex?: number;
  toolName: string;
  arguments?: Record<string, unknown>;
  /** Historical declaration; missing policies are never replayable. */
  replay: 'safe' | 'never';
  /** `'replay'`：可安全重放；`'synthesize'`：绝不重跑，必须合成占位结果。 */
  action: 'replay' | 'synthesize';
  contract?: unknown;
  reason?: string;
}

/**
 * 纯函数：为所有被中断的工具调用生成恢复决策。
 *
 * - 已有 settlement 的调用在归约时即变为 settled/failed，不会出现在本清单——
 *   这正是"结算不重放"不变量：结果一旦持久化，恢复时绝不重跑外部副作用；
 * - `replay: 'never'`（或被 output-length 拦截）的调用 → `synthesize`；
 * - 历史与当前都显式允许 safe，且版本、schema 和注册权限兼容，才允许 replay。
 */
export function planInterruptedRecovery(
  state: MaterializedSessionState,
  tools?: ToolRegistry
): InterruptedToolRecoveryPlan[] {
  const plans: InterruptedToolRecoveryPlan[] = [];
  const invocationIds = new Set<string>();
  for (const op of state.operations.values()) {
    if (op.state !== 'interrupted' || op.type !== 'tool_call') continue;
    const intent = (op.intent ?? {}) as {
      name?: unknown;
      arguments?: Record<string, unknown>;
      replay?: unknown;
      invocationId?: unknown;
      toolCallId?: unknown;
      sourceIndex?: unknown;
      contract?: unknown;
    };
    const replay = intent.replay === 'safe' ? 'safe' : 'never';
    const invocationId = typeof intent.invocationId === 'string' ? intent.invocationId : op.id;
    if (!invocationId || invocationIds.has(invocationId))
      throw new Error('Ambiguous interrupted tool invocation identity');
    invocationIds.add(invocationId);
    const toolName = typeof intent.name === 'string' ? intent.name : 'unknown_tool';
    const current = tools?.get(toolName);
    const reason =
      replay !== 'safe'
        ? 'historical-policy'
        : !current
          ? 'tool-missing'
          : current.replay !== 'safe'
            ? 'current-policy'
            : !toolReplayContractsMatch(intent.contract, tools?.getReplayContract(toolName))
              ? 'contract-changed'
              : !tools?.validateParameters(current, intent.arguments ?? {}).valid
                ? 'invalid-arguments'
                : undefined;
    plans.push({
      invocationId,
      operationId: op.id,
      toolName,
      ...(typeof intent.toolCallId === 'string' ? { toolCallId: intent.toolCallId } : {}),
      ...(typeof intent.sourceIndex === 'number' ? { sourceIndex: intent.sourceIndex } : {}),
      arguments: intent.arguments === undefined ? undefined : structuredClone(intent.arguments),
      replay,
      action: reason ? 'synthesize' : 'replay',
      ...(intent.contract !== undefined ? { contract: structuredClone(intent.contract) } : {}),
      ...(reason ? { reason } : {})
    });
  }
  return plans;
}

/**
 * 为 `action: 'synthesize'` 的中断调用构造"结果未知"占位结果。
 *
 * 对齐上游 unsafe orphan synthesis：不重跑外部副作用，向模型明确说明
 * 工具未执行且结果未知，需要人工确认后继续。
 */
export function synthesizeInterruptedToolResult(
  plan: InterruptedToolRecoveryPlan,
  clock: () => number = Date.now
): ToolResultMessage {
  return {
    id: plan.invocationId,
    role: 'toolResult',
    toolCallId:
      plan.toolCallId ??
      (plan.operationId.startsWith('op_tool_') ? plan.operationId.slice('op_tool_'.length) : plan.operationId),
    toolName: plan.toolName,
    isError: true,
    content: [
      {
        type: 'text',
        text: `Tool '${plan.toolName}' was interrupted by a crash and ${plan.replay === 'never' ? "its replay policy is 'never'" : `replay was refused (${plan.reason ?? 'incompatible contract'})`}. The external effect was NOT re-executed; the result is unknown and requires manual verification.`
      }
    ],
    timestamp: clock()
  };
}
