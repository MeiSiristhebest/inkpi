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
});
