import {
  AssistantFrameEncoder,
  MessageQueue,
  SessionRegistry,
  ToolDispatcher,
  ToolRegistry,
  detectAndMarkInterruptedOperations,
  planInterruptedRecovery,
  reduceAssistantFrames,
  reduceSession,
  synthesizeInterruptedToolResult
} from '@inkpi/agent-core';
import { getModelPreset } from '@inkpi/ai';
import type { AssistantMessage, SessionEntry, ToolCallContent } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

/** 每个测试独立的条目工厂（seq 单调递增）。 */
function createEntryFactory(sessionId = 'sess_inv') {
  let seq = 0;
  return (id: string, type: SessionEntry['type'], payload: unknown, timestamp = 1000): SessionEntry => {
    seq += 1;
    return { id, sessionId, seq, parentId: null, type, timestamp, payload } as SessionEntry;
  };
}

const ASSISTANT_WITH_TOOLS: AssistantMessage = {
  id: 'asst_1',
  role: 'assistant',
  content: [
    { type: 'text', text: 'plan' },
    { type: 'toolCall', id: 'call_a', name: 'tool_a', arguments: {} },
    { type: 'toolCall', id: 'call_b', name: 'tool_b', arguments: {} },
    { type: 'toolCall', id: 'call_c', name: 'tool_c', arguments: {} }
  ],
  stopReason: 'tool_use'
};

function toolExecutionPayload(callId: string, text: string, sourceIndex?: number): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    role: 'toolResult',
    toolCallId: callId,
    toolName: `tool_${callId.slice(5)}`,
    content: [{ type: 'text', text }],
    isError: false
  };
  if (sourceIndex !== undefined) payload.sourceIndex = sourceIndex;
  return payload;
}

describe('P0：恢复后工具结果按源序物化', () => {
  it('journal 完成序 + sourceIndex → 归约后按源序排列', () => {
    const mk = createEntryFactory();
    // 完成序：B → C → A（A 最慢）
    const entries: SessionEntry[] = [
      mk('u1', 'user_message', { content: 'go' }),
      mk('a1', 'agent_turn', ASSISTANT_WITH_TOOLS),
      mk('te_b', 'tool_execution', toolExecutionPayload('call_b', 'B done', 2)),
      mk('te_c', 'tool_execution', toolExecutionPayload('call_c', 'C done', 3)),
      mk('te_a', 'tool_execution', toolExecutionPayload('call_a', 'A done', 1))
    ];

    const state = reduceSession(entries);
    const toolResults = state.messages.filter((m) => m.role === 'toolResult');
    expect(toolResults.map((m) => (m as any).toolCallId)).toEqual(['call_a', 'call_b', 'call_c']);
  });

  it('无 sourceIndex 的旧条目保持 journal 序（零回归）', () => {
    const mk = createEntryFactory();
    const entries: SessionEntry[] = [
      mk('u1', 'user_message', { content: 'go' }),
      mk('a1', 'agent_turn', ASSISTANT_WITH_TOOLS),
      mk('te_b', 'tool_execution', toolExecutionPayload('call_b', 'B done')),
      mk('te_c', 'tool_execution', toolExecutionPayload('call_c', 'C done')),
      mk('te_a', 'tool_execution', toolExecutionPayload('call_a', 'A done'))
    ];

    const state = reduceSession(entries);
    const toolResults = state.messages.filter((m) => m.role === 'toolResult');
    expect(toolResults.map((m) => (m as any).toolCallId)).toEqual(['call_b', 'call_c', 'call_a']);
  });

  it('缓冲的工具结果在下一条 user_message 前物化', () => {
    const mk = createEntryFactory();
    const entries: SessionEntry[] = [
      mk('u1', 'user_message', { content: 'go' }),
      mk('a1', 'agent_turn', ASSISTANT_WITH_TOOLS),
      mk('te_b', 'tool_execution', toolExecutionPayload('call_b', 'B done', 2)),
      mk('u2', 'user_message', { content: 'next' })
    ];

    const state = reduceSession(entries);
    const roles = state.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'toolResult', 'user']);
  });
});

describe('P1：助手流式帧持久化', () => {
  it('编码器：块起始快照 + delta；终态不产帧；迟到增量被拒收', () => {
    const encoder = new AssistantFrameEncoder();
    expect(encoder.encode({ type: 'text_delta', textDelta: 'he' })).toEqual({ type: 'text_start', index: 0, text: '' });
    expect(encoder.encode({ type: 'text_delta', textDelta: 'llo' })).toEqual({
      type: 'text_delta',
      index: 0,
      delta: 'llo'
    });
    expect(encoder.encode({ type: 'thinking_delta', thinkingDelta: 'think' })).toEqual({
      type: 'thinking_start',
      index: 1,
      thinking: ''
    });

    expect(encoder.encode({ type: 'tool_call_start', toolCallId: 'c1', toolName: 'search' })).toEqual({
      type: 'tool_call_start',
      index: 2,
      toolCallId: 'c1',
      toolName: 'search'
    });
    expect(encoder.encode({ type: 'tool_call_delta', toolCallId: 'c1', argsDelta: '{"q"' })).toEqual({
      type: 'tool_call_args',
      index: 2,
      toolCallId: 'c1',
      delta: '{"q"'
    });
    expect(
      encoder.encode({
        type: 'tool_call_end',
        toolCall: { type: 'toolCall', id: 'c1', name: 'search', arguments: { q: 'x' } }
      })
    ).toMatchObject({ type: 'tool_call_end', index: 2 });
    // 结算后迟到增量：fencing，丢弃
    expect(encoder.encode({ type: 'tool_call_delta', toolCallId: 'c1', argsDelta: '!' })).toBeNull();
    // 终态事件：不产帧
    expect(encoder.encode({ type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } })).toBeNull();
    expect(encoder.encode({ type: 'error', error: 'boom' })).toBeNull();
  });

  it('归约器：按帧重建部分消息；未完结调用尽力解析参数', () => {
    const partial = reduceAssistantFrames([
      { type: 'text_start', index: 0, text: '' },
      { type: 'text_delta', index: 0, delta: 'once upon' },
      { type: 'tool_call_start', index: 1, toolCallId: 'c1', toolName: 'draft' },
      { type: 'tool_call_args', index: 1, toolCallId: 'c1', delta: '{"chapter":1}' }
    ]);
    expect(partial).not.toBeNull();
    expect(partial!.stopReason).toBe('aborted');
    expect(partial!.content[0]).toEqual({ type: 'text', text: 'once upon' });
    const toolBlock = partial!.content[1] as ToolCallContent;
    expect(toolBlock.name).toBe('draft');
    expect(toolBlock.arguments).toEqual({ chapter: 1 });
  });

  it('reduceSession：agent_turn 落地后丢弃帧；无终态时重建部分消息', () => {
    const mk = createEntryFactory();
    const frameEntries: SessionEntry[] = [
      mk('u1', 'user_message', { content: 'go' }),
      mk('f1', 'assistant_frame', { opId: 'op_1', frame: { type: 'text_start', index: 0, text: '' } }),
      mk('f2', 'assistant_frame', { opId: 'op_1', frame: { type: 'text_delta', index: 0, delta: 'partial…' } })
    ];

    // 无终态 → 合成部分消息
    const crashed = reduceSession(frameEntries);
    const last = crashed.messages[crashed.messages.length - 1] as AssistantMessage;
    expect(last.role).toBe('assistant');
    expect(last.stopReason).toBe('aborted');
    expect(last.content[0]).toEqual({ type: 'text', text: 'partial…' });

    // 有终态 → 帧被丢弃，只保留权威消息
    const settled = reduceSession([
      ...frameEntries,
      mk('a1', 'agent_turn', {
        ...ASSISTANT_WITH_TOOLS,
        content: [{ type: 'text', text: 'final' }],
        stopReason: 'stop'
      })
    ]);
    expect(settled.pendingAssistantFrames).toHaveLength(0);
    const assistantMsgs = settled.messages.filter((m) => m.role === 'assistant') as AssistantMessage[];
    expect(assistantMsgs).toHaveLength(1);
    expect(assistantMsgs[0].content[0]).toEqual({ type: 'text', text: 'final' });
  });
});

describe('P1：replay 合约与恢复规划', () => {
  it('interrupted + never → synthesize；safe → replay；已结算不进入清单', () => {
    const mk = createEntryFactory();
    const neverEntries: SessionEntry[] = [
      mk('u1', 'user_message', { content: 'go' }),
      mk('i1', 'operation_intent', {
        id: 'op_tool_call_x',
        type: 'tool_call',
        invocationId: 'inv_1',
        replay: 'never',
        intent: { name: 'shell', arguments: { cmd: 'deploy' } }
      })
    ];
    const interrupted = detectAndMarkInterruptedOperations(reduceSession(neverEntries), () => 2000);
    const plans = planInterruptedRecovery(interrupted.state);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      invocationId: 'inv_1',
      operationId: 'op_tool_call_x',
      toolName: 'shell',
      replay: 'never',
      action: 'synthesize'
    });

    // 已结算：绝不进入恢复清单（"结算不重放"不变量）
    const settledEntries: SessionEntry[] = [
      ...neverEntries,
      mk('s1', 'operation_settlement', { id: 'op_tool_call_x', type: 'tool_call', settlement: { ok: true } })
    ];
    const settledState = reduceSession(settledEntries);
    expect(planInterruptedRecovery(settledState)).toHaveLength(0);
    expect(settledState.operations.get('op_tool_call_x')?.state).toBe('settled');

    // safe → replay
    const safeEntries: SessionEntry[] = [
      mk('i2', 'operation_intent', {
        id: 'op_tool_call_y',
        type: 'tool_call',
        invocationId: 'inv_2',
        replay: 'safe',
        intent: { name: 'read_doc', arguments: {} }
      })
    ];
    const safeInterrupted = detectAndMarkInterruptedOperations(reduceSession(safeEntries), () => 2000);
    expect(planInterruptedRecovery(safeInterrupted.state)[0]?.action).toBe('replay');
  });

  it('合成占位结果：不重跑副作用，明确"结果未知"', () => {
    const synthetic = synthesizeInterruptedToolResult({
      invocationId: 'inv_1',
      operationId: 'op_tool_call_x',
      toolName: 'shell',
      arguments: { cmd: 'deploy' },
      replay: 'never',
      action: 'synthesize'
    });
    expect(synthetic.isError).toBe(true);
    expect(synthetic.toolCallId).toBe('call_x');
    expect(synthetic.id).toBe('inv_1');
    expect((synthetic.content[0] as any).text).toContain("replay policy is 'never'");
  });

  it('SessionRegistry 恢复：never 中断调用自动合成占位结果', () => {
    const mk = createEntryFactory('sess_restore');
    const entries: SessionEntry[] = [
      mk('u1', 'user_message', { content: 'go' }),
      mk('i1', 'operation_intent', {
        id: 'op_tool_call_x',
        type: 'tool_call',
        invocationId: 'inv_1',
        replay: 'never',
        intent: { name: 'shell', arguments: { cmd: 'deploy' } }
      }),
      mk('a1', 'agent_turn', ASSISTANT_WITH_TOOLS)
    ];

    const registry = new SessionRegistry(() => 1000, getModelPreset('mock-test'));
    const managed = registry.createSession({ sessionId: 'sess_restore', entries });
    const toolResults = managed.agent.state.messages.filter((m) => m.role === 'toolResult');
    expect(toolResults).toHaveLength(1);
    expect((toolResults[0] as any).toolName).toBe('shell');
    expect((toolResults[0] as any).isError).toBe(true);
  });
});

describe('P2：dispatcher journal 合约（invocationId / sourceIndex / checkpoint / fencing）', () => {
  it('意图携带预保留 invocationId 与 replay；结果条目 id=invocationId；checkpoint 落 journal', async () => {
    const journal = new AppendOnlySessionJournal({ sessionId: 'sess_disp' });
    const emitted: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: 'quick_tool',
      description: 'emits live + checkpoint updates then settles',
      replay: 'never',
      execute: async (_id, _args, _signal, onUpdate) => {
        onUpdate?.({ content: [{ type: 'text', text: 'live' }] });
        onUpdate?.({ content: [{ type: 'text', text: 'checkpoint-snapshot' }] }, { checkpoint: true });
        return { content: [{ type: 'text' as const, text: 'done' }] };
      }
    });

    const ctx = {
      state: { messages: [], pendingToolCalls: new Set<string>() } as any,
      options: { journal, toolExecution: 'sequential' } as any,
      toolRegistry: registry,
      steeringQueue: new MessageQueue(),
      followUpQueue: new MessageQueue(),
      emitEvent: async (event: any) => {
        emitted.push(event.type);
      },
      clock: () => 12345
    };

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'call it' },
        { type: 'toolCall', id: 'call_q', name: 'quick_tool', arguments: {} }
      ],
      stopReason: 'tool_use'
    };

    const dispatcher = new ToolDispatcher();
    const result = await dispatcher.dispatch(ctx as any, assistantMessage);
    expect(result.toolResults).toHaveLength(1);

    const entries = journal.getEntries();
    const intent = entries.find((e) => e.type === 'operation_intent')!;
    expect(intent.payload.replay).toBe('never');
    expect(typeof intent.payload.invocationId).toBe('string');

    const execution = entries.find((e) => e.type === 'tool_execution')!;
    expect(execution.id).toBe(intent.payload.invocationId); // 预保留身份 = 结果条目 id
    expect(execution.payload.sourceIndex).toBe(1);
    expect(execution.payload.invocationId).toBe(intent.payload.invocationId);

    const progress = entries.filter((e) => e.type === 'tool_progress');
    expect(progress).toHaveLength(1);
    expect(progress[0].payload.snapshot.content).toEqual([{ type: 'text', text: 'checkpoint-snapshot' }]);
    expect(progress[0].payload.invocationId).toBe(intent.payload.invocationId);

    // 迟到的更新在 fencing 之后不再产生事件（该工具从未请求 checkpoint 之外的第二发）
    expect(emitted.filter((t) => t === 'tool_execution_update')).toHaveLength(2);
  });

  it('fencing：结算后迟到的 onUpdate 被拒收', async () => {
    const journal = new AppendOnlySessionJournal({ sessionId: 'sess_fence' });
    const emitted: string[] = [];
    const registry = new ToolRegistry();
    let lateUpdate: (() => void) | undefined;
    registry.register({
      name: 'late_tool',
      description: 'calls onUpdate after settling',
      execute: async (_id, _args, _signal, onUpdate) => {
        const result = { content: [{ type: 'text' as const, text: 'done' }] };
        // 模拟异步迟到写：结算完成后再触发
        Promise.resolve().then(() => {
          lateUpdate = () => onUpdate?.({ content: [{ type: 'text', text: 'LATE' }] });
        });
        return result;
      }
    });

    const ctx = {
      state: { messages: [], pendingToolCalls: new Set<string>() } as any,
      options: { journal, toolExecution: 'sequential' } as any,
      toolRegistry: registry,
      steeringQueue: new MessageQueue(),
      followUpQueue: new MessageQueue(),
      emitEvent: async (event: any) => {
        emitted.push(event.type);
      },
      clock: () => 999
    };

    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call_l', name: 'late_tool', arguments: {} }],
      stopReason: 'tool_use'
    };

    await new ToolDispatcher().dispatch(ctx as any, assistantMessage);
    // 结算已完成；此刻触发的迟到更新必须被 fencing 拦截
    if (lateUpdate) lateUpdate();
    await Promise.resolve();
    expect(emitted.filter((t) => t === 'tool_execution_update')).toHaveLength(0);
  });
});
