/**
 * Pure Function SessionReducer
 * 接收 SessionEntry[] 日志流，纯函数计算物化会话状态 (MaterializedSessionState)。
 */

import type {
  AgentMessage,
  AssistantMessage,
  JournalEntry,
  OperationRecord,
  OperationState,
  SessionEntry,
  StateLedger,
  ToolResultMessage,
  Usage,
  UserMessage
} from '@inkpi/protocol';
import type { AssistantStreamFrame } from '../turn/assistant-frames.js';
import { reduceAssistantFrames } from '../turn/assistant-frames.js';

export interface TokenUsageSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface MaterializedSessionState {
  sessionId: string;
  currentLeafId: string | null;
  activeLaneId: string;
  messages: AgentMessage[];
  operations: Map<string, OperationRecord>;
  usageTotals: TokenUsageSummary;
  factsLedger: Record<string, unknown>;
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

export function createInitialSessionState(sessionId = 'default'): MaterializedSessionState {
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
    factsLedger: {},
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
function flushPendingToolResults(state: MaterializedSessionState): MaterializedSessionState {
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
export function reduceSessionEntry(
  state: MaterializedSessionState,
  entry: SessionEntry | JournalEntry
): MaterializedSessionState {
  const next: MaterializedSessionState = {
    ...state,
    messages: [...state.messages],
    operations: new Map(state.operations),
    usageTotals: { ...state.usageTotals },
    factsLedger: { ...state.factsLedger },
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
  if (entry.type !== 'tool_execution' && entry.type !== 'assistant_frame') {
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
      const payload = entry.payload;
      const userMsg: UserMessage = {
        id: entry.id,
        role: 'user',
        content: typeof payload === 'string' ? payload : (payload?.content ?? payload?.text ?? ''),
        timestamp: entry.timestamp
      };
      next.messages.push(userMsg);
      break;
    }

    case 'agent_turn': {
      const payload = entry.payload;
      const assistantMsg: AssistantMessage = {
        id: entry.id,
        role: 'assistant',
        content: Array.isArray(payload?.content)
          ? payload.content
          : [{ type: 'text', text: payload?.content || payload?.text || '' }],
        stopReason: payload?.stopReason || 'stop',
        errorMessage: payload?.errorMessage,
        usage: payload?.usage,
        timestamp: entry.timestamp
      };
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
      const toolMsg: ToolResultMessage = {
        id: entry.id,
        role: 'toolResult',
        toolCallId: payload?.toolCallId || payload?.id || entry.id,
        toolName: payload?.toolName || payload?.name || 'unknown_tool',
        content: Array.isArray(payload?.content)
          ? payload.content
          : [
              {
                type: 'text',
                text: typeof payload?.result === 'string' ? payload.result : JSON.stringify(payload?.result || '')
              }
            ],
        details: payload?.details,
        isError: Boolean(payload?.isError || payload?.error),
        timestamp: entry.timestamp
      };
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
        next.pendingAssistantFrames.push(frame);
      }
      break;
    }

    case 'operation_intent': {
      const op = entry.payload;
      if (op && typeof op.id === 'string') {
        const existing = next.operations.get(op.id);
        // 持久性合约：payload 顶层的 replay / invocationId 必须并入记录的 intent，
        // 否则恢复规划（planInterruptedRecovery）无法读取重放策略。
        const intentExtras: Record<string, unknown> = {};
        if (op.replay !== undefined) intentExtras.replay = op.replay;
        if (op.invocationId !== undefined) intentExtras.invocationId = op.invocationId;
        const baseIntent = op.intent !== undefined ? op.intent : op;
        const storedIntent =
          baseIntent && typeof baseIntent === 'object' && !Array.isArray(baseIntent)
            ? { ...(baseIntent as Record<string, unknown>), ...intentExtras }
            : baseIntent;
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
      const op = entry.payload;
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
      const ledger = entry.payload?.ledger || entry.payload;
      if (ledger && typeof ledger === 'object') {
        next.factsLedger = {
          ...next.factsLedger,
          ...(ledger as Record<string, unknown>)
        };
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
        next.factsLedger._lastCompactionSummary = summary;
      }
      break;
    }

    default:
      break;
  }

  return next;
}

/**
 * 纯函数：全量归约 SessionEntry 日志列表
 */
export function reduceSession(
  entries: (SessionEntry | JournalEntry)[],
  initialState?: MaterializedSessionState
): MaterializedSessionState {
  const base = initialState
    ? structuredClone(initialState)
    : createInitialSessionState(entries[0]?.sessionId || 'default');

  const reduced = entries.reduce((state, entry) => reduceSessionEntry(state, entry), base);

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
  for (const [id, op] of state.operations.entries()) {
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

/** 单个被中断工具调用的恢复决策（对齐上游 pi tool-durability 的 replay 合约）。 */
export interface InterruptedToolRecoveryPlan {
  /** 预保留的调用身份（tool_execution 条目 id），重放时必须复用。 */
  invocationId: string;
  /** operation_intent 条目使用的操作 id（形如 `op_tool_<toolCallId>`）。 */
  operationId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  /** 归一化后的重放策略：intent 未标注时视为 `'safe'`。 */
  replay: 'safe' | 'never';
  /** `'replay'`：可安全重放；`'synthesize'`：绝不重跑，必须合成占位结果。 */
  action: 'replay' | 'synthesize';
}

/**
 * 纯函数：为所有被中断的工具调用生成恢复决策。
 *
 * - 已有 settlement 的调用在归约时即变为 settled/failed，不会出现在本清单——
 *   这正是"结算不重放"不变量：结果一旦持久化，恢复时绝不重跑外部副作用；
 * - `replay: 'never'`（或被 output-length 拦截）的调用 → `synthesize`；
 * - `'safe'`/未标注 → `replay`（重放方应复用 plan.invocationId 保持日志一致）。
 */
export function planInterruptedRecovery(state: MaterializedSessionState): InterruptedToolRecoveryPlan[] {
  const plans: InterruptedToolRecoveryPlan[] = [];
  for (const op of state.operations.values()) {
    if (op.state !== 'interrupted' || op.type !== 'tool_call') continue;
    const intent = (op.intent ?? {}) as {
      name?: unknown;
      arguments?: Record<string, unknown>;
      replay?: unknown;
      invocationId?: unknown;
    };
    const replay = intent.replay === 'never' ? 'never' : 'safe';
    plans.push({
      invocationId: typeof intent.invocationId === 'string' ? intent.invocationId : op.id,
      operationId: op.id,
      toolName: typeof intent.name === 'string' ? intent.name : 'unknown_tool',
      arguments: intent.arguments,
      replay,
      action: replay === 'never' ? 'synthesize' : 'replay'
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
    toolCallId: plan.operationId.startsWith('op_tool_') ? plan.operationId.slice('op_tool_'.length) : plan.operationId,
    toolName: plan.toolName,
    isError: true,
    content: [
      {
        type: 'text',
        text: `Tool '${plan.toolName}' was interrupted by a crash and its replay policy is 'never'. The external effect was NOT re-executed; the result is unknown and requires manual verification.`
      }
    ],
    timestamp: clock()
  };
}
