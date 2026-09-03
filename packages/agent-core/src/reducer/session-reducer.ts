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
    revisions: new Map()
  };
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
    revisions: new Map(state.revisions)
  };

  if (!next.sessionId && entry.sessionId) {
    next.sessionId = entry.sessionId;
  }
  if (entry.laneId) {
    next.activeLaneId = entry.laneId;
  }
  next.currentLeafId = entry.id;

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
      next.messages.push(toolMsg);
      break;
    }

    case 'operation_intent': {
      const op = entry.payload;
      if (op && typeof op.id === 'string') {
        const existing = next.operations.get(op.id);
        next.operations.set(op.id, {
          id: op.id,
          sessionId: next.sessionId,
          type: op.type || 'custom',
          state: (op.state as OperationState) || 'running',
          intent: op.intent !== undefined ? op.intent : op,
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

  return entries.reduce((state, entry) => reduceSessionEntry(state, entry), base);
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
