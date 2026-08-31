import { describe, it, expect } from 'vitest';
import {
  createInitialSessionState,
  reduceSessionEntry,
  reduceSession,
  detectAndMarkInterruptedOperations
} from '@inkpi/agent-core';
import type { SessionEntry } from '@inkpi/protocol';

describe('@inkpi/agent-core -> SessionReducer (Pure Event Sourcing State Machine)', () => {
  it('should create empty initial session state', () => {
    const state = createInitialSessionState('sess_test_1');
    expect(state.sessionId).toBe('sess_test_1');
    expect(state.messages).toEqual([]);
    expect(state.operations.size).toBe(0);
    expect(state.currentLeafId).toBeNull();
    expect(state.activeLaneId).toBe('main');
  });

  it('should deterministically reduce user, agent, and tool entries', () => {
    const entries: SessionEntry[] = [
      {
        id: 'entry_1',
        sessionId: 'sess_1',
        seq: 1,
        parentId: null,
        laneId: 'main',
        type: 'session_start',
        timestamp: 1000,
        payload: {}
      },
      {
        id: 'entry_2',
        sessionId: 'sess_1',
        seq: 2,
        parentId: 'entry_1',
        type: 'user_message',
        timestamp: 1010,
        payload: { content: 'Please summarize project vision' }
      },
      {
        id: 'entry_3',
        sessionId: 'sess_1',
        seq: 3,
        parentId: 'entry_2',
        type: 'agent_turn',
        timestamp: 1020,
        payload: {
          content: [{ type: 'text', text: 'Here is the summary' }],
          usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 }
        }
      },
      {
        id: 'entry_4',
        sessionId: 'sess_1',
        seq: 4,
        parentId: 'entry_3',
        type: 'tool_execution',
        timestamp: 1030,
        payload: {
          toolCallId: 'call_1',
          toolName: 'read_file',
          result: 'file contents',
          isError: false
        }
      }
    ];

    const state = reduceSession(entries);
    expect(state.sessionId).toBe('sess_1');
    expect(state.currentLeafId).toBe('entry_4');
    expect(state.messages).toHaveLength(3);
    expect(state.messages[0].role).toBe('user');
    expect(state.messages[1].role).toBe('assistant');
    expect(state.messages[2].role).toBe('toolResult');
    expect(state.usageTotals.totalTokens).toBe(80);
  });

  it('should track operation intent and settlement two-phase lifecycle', () => {
    const entries: SessionEntry[] = [
      {
        id: 'e1',
        sessionId: 'sess_op',
        seq: 1,
        parentId: null,
        type: 'operation_intent',
        timestamp: 2000,
        payload: {
          id: 'op_tool_1',
          type: 'tool_call',
          intent: { name: 'exec_sql', query: 'SELECT 1' }
        }
      },
      {
        id: 'e2',
        sessionId: 'sess_op',
        seq: 2,
        parentId: 'e1',
        type: 'operation_settlement',
        timestamp: 2050,
        payload: {
          id: 'op_tool_1',
          settlement: { rows: [1] }
        }
      }
    ];

    const state = reduceSession(entries);
    const op = state.operations.get('op_tool_1');
    expect(op).toBeDefined();
    expect(op?.state).toBe('settled');
    expect(op?.settlement).toEqual({ rows: [1] });
  });

  it('should detect and mark interrupted operations upon recovery after sudden crash', () => {
    const entries: SessionEntry[] = [
      {
        id: 'e1',
        sessionId: 'sess_crash',
        seq: 1,
        parentId: null,
        type: 'operation_intent',
        timestamp: 3000,
        payload: {
          id: 'op_hanging_stream',
          type: 'provider_stream',
          intent: { model: 'claude-3-5-sonnet' }
        }
      }
    ];

    const state = reduceSession(entries);
    expect(state.operations.get('op_hanging_stream')?.state).toBe('running');

    const recovery = detectAndMarkInterruptedOperations(state);
    expect(recovery.recoveredCount).toBe(1);
    expect(recovery.interruptedIds).toContain('op_hanging_stream');
    expect(state.operations.get('op_hanging_stream')?.state).toBe('interrupted');
  });

  it('should be pure and idempotent on replay', () => {
    const entries: SessionEntry[] = [
      {
        id: 'e1',
        sessionId: 'sess_idem',
        seq: 1,
        parentId: null,
        type: 'user_message',
        timestamp: 4000,
        payload: 'hello world'
      }
    ];

    const state1 = reduceSession(entries);
    const state2 = reduceSession(entries);
    expect(state1).toEqual(state2);
  });

  it('should reduce ledger_mutation, draft_revision, compaction, and error operation settlements', () => {
    const entries: SessionEntry[] = [
      {
        id: 'e_start',
        sessionId: 'sess_mut',
        seq: 1,
        parentId: null,
        laneId: 'feature_branch',
        type: 'session_start',
        timestamp: 5000,
        payload: { laneId: 'feature_branch' }
      },
      {
        id: 'e_rev',
        sessionId: 'sess_mut',
        seq: 2,
        parentId: 'e_start',
        type: 'draft_revision',
        timestamp: 5010,
        payload: { documentId: 'doc_101', version: 3, markdown: '# Title' }
      },
      {
        id: 'e_ledg',
        sessionId: 'sess_mut',
        seq: 3,
        parentId: 'e_rev',
        type: 'ledger_mutation',
        timestamp: 5020,
        payload: { ledger: { theme: 'cyberpunk', entities: [{ name: 'K' }] } }
      },
      {
        id: 'e_comp',
        sessionId: 'sess_mut',
        seq: 4,
        parentId: 'e_ledg',
        type: 'compaction',
        timestamp: 5030,
        payload: { summary: 'Compressed 100 turns into context snapshot' }
      },
      {
        id: 'e_op_fail',
        sessionId: 'sess_mut',
        seq: 5,
        parentId: 'e_comp',
        type: 'operation_settlement',
        timestamp: 5040,
        payload: { id: 'op_failing_call', type: 'tool_call', error: 'Network timeout' }
      }
    ];

    const state = reduceSession(entries);
    expect(state.activeLaneId).toBe('feature_branch');
    expect(state.revisions.get('doc_101')).toBe(3);
    expect(state.factsLedger.theme).toBe('cyberpunk');
    expect(state.factsLedger._lastCompactionSummary).toContain('Compressed 100 turns');
    expect(state.operations.get('op_failing_call')?.state).toBe('failed');
    expect(state.operations.get('op_failing_call')?.error).toBe('Network timeout');
  });

  it('should handle edge-case payloads, empty defaults, and custom entries gracefully', () => {
    const rawState = createInitialSessionState('');
    expect(rawState.sessionId).toBe('');

    const entries: SessionEntry[] = [
      {
        id: 'e_custom',
        sessionId: 'sess_edge',
        seq: 1,
        parentId: null,
        type: 'custom',
        timestamp: 6000,
        payload: { arbitrary: 123 }
      },
      {
        id: 'e_user_plain',
        sessionId: 'sess_edge',
        seq: 2,
        parentId: 'e_custom',
        type: 'user_message',
        timestamp: 6010,
        payload: 'plain text prompt'
      },
      {
        id: 'e_user_fallback',
        sessionId: 'sess_edge',
        seq: 3,
        parentId: 'e_user_plain',
        type: 'user_message',
        timestamp: 6020,
        payload: {}
      },
      {
        id: 'e_agent_plain',
        sessionId: 'sess_edge',
        seq: 4,
        parentId: 'e_user_fallback',
        type: 'agent_turn',
        timestamp: 6030,
        payload: { text: 'fallback text' }
      },
      {
        id: 'e_tool_plain',
        sessionId: 'sess_edge',
        seq: 5,
        parentId: 'e_agent_plain',
        type: 'tool_execution',
        timestamp: 6040,
        payload: { result: { count: 99 } }
      },
      {
        id: 'e_op_empty',
        sessionId: 'sess_edge',
        seq: 6,
        parentId: 'e_tool_plain',
        type: 'operation_intent',
        timestamp: 6050,
        payload: { id: 'op_generic' }
      }
    ];

    const reduced = reduceSession(entries, rawState);
    expect(reduced.sessionId).toBe('sess_edge');
    expect(reduced.messages.length).toBe(4);
    expect(reduced.operations.get('op_generic')?.state).toBe('running');

    // Recovery test on settled operations
    reduced.operations.set('op_done', {
      id: 'op_done',
      sessionId: 'sess_edge',
      type: 'custom',
      state: 'settled',
      intent: {},
      createdAt: 1,
      updatedAt: 2
    });

    const recovery = detectAndMarkInterruptedOperations(reduced);
    expect(recovery.recoveredCount).toBe(1);
    expect(recovery.interruptedIds).toEqual(['op_generic']);
  });
});
