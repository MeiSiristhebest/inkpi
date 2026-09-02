import type { AgentEvent, AgentMessage, AssistantMessage, ToolResultMessage } from '@inkpi/protocol';
import { describe, expect, it, vi } from 'vitest';
import { MessageQueue } from '../packages/agent-core/src/queues.js';
import { ToolRegistry } from '../packages/agent-core/src/tools.js';
import { ContextTransformer } from '../packages/agent-core/src/turn/context-transformer.js';
import { extractToolCalls } from '../packages/agent-core/src/turn/extract-tool-calls.js';
import { ToolDispatcher } from '../packages/agent-core/src/turn/tool-dispatcher.js';
import { TurnFinalizer } from '../packages/agent-core/src/turn/turn-finalizer.js';
import type { AgentOptions, AgentState } from '../packages/agent-core/src/types.js';

type Queues = {
  steering: MessageQueue;
  followUp: MessageQueue;
};

function queueOf(...msgs: AgentMessage[]): MessageQueue {
  const q = new MessageQueue();
  q.enqueue(...msgs);
  return q;
}

function makeState(messages: AgentMessage[] = []): AgentState {
  return {
    systemPrompt: 'sys',
    model: { id: 'm1' } as any,
    thinkingLevel: 'off',
    tools: [],
    messages,
    isStreaming: false,
    pendingToolCalls: new Set<string>()
  };
}

function makeCtx(
  overrides: {
    state?: AgentState;
    options?: AgentOptions;
    toolRegistry?: ToolRegistry;
    queues?: Partial<Queues>;
  } = {}
) {
  const events: AgentEvent[] = [];
  const emitEvent = async (event: AgentEvent) => {
    events.push(event);
  };
  const state = overrides.state ?? makeState();
  const ctx = {
    state,
    options: overrides.options ?? {},
    toolRegistry: overrides.toolRegistry ?? new ToolRegistry(),
    steeringQueue: overrides.queues?.steering ?? new MessageQueue(),
    followUpQueue: overrides.queues?.followUp ?? new MessageQueue(),
    emitEvent,
    signal: undefined as AbortSignal | undefined,
    clock: () => 1000
  };
  return { ctx, events, state };
}

function assistantMsg(content: AssistantMessage['content']): AssistantMessage {
  return { role: 'assistant', content, timestamp: 1 } as AssistantMessage;
}

describe('ContextTransformer (管线第 1 段)', () => {
  it('无 transformContext / convertToLlm 时原样返回消息副本', async () => {
    const { ctx, state } = makeCtx({ state: makeState([{ role: 'user', content: [], timestamp: 1 } as AgentMessage]) });
    const out = await new ContextTransformer().prepare(ctx);
    expect(out).toHaveLength(1);
    expect(out).not.toBe(state.messages); // 返回副本，不共享引用
  });

  it('drain 出来的 steering 消息会并入历史并派发生命周期事件', async () => {
    const steeringMsg = { role: 'user', content: [], timestamp: 1 } as AgentMessage;
    const steering = queueOf(steeringMsg);
    const { ctx, events, state } = makeCtx({ queues: { steering } });

    const out = await new ContextTransformer().prepare(ctx);

    expect(state.messages).toContain(steeringMsg);
    expect(out).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['message_start', 'message_end']);
    expect(steering.size()).toBe(0);
  });

  it('依次应用 transformContext 与 convertToLlm', async () => {
    const base = { role: 'user', content: [], timestamp: 1 } as AgentMessage;
    const { ctx } = makeCtx({
      state: makeState([base]),
      options: {
        transformContext: async (msgs) => [...msgs, { role: 'user', content: [], timestamp: 2 } as AgentMessage],
        convertToLlm: async (msgs) => msgs.slice(0, 1)
      }
    });

    const out = await new ContextTransformer().prepare(ctx);
    // transformContext 追加到 2 条，convertToLlm 裁回 1 条
    expect(out).toHaveLength(1);
  });

  it('transformContext 收到的是包含 steering 消息的历史', async () => {
    const steeringMsg = { role: 'user', content: [], timestamp: 9 } as AgentMessage;
    const seen: number[] = [];
    const { ctx } = makeCtx({
      queues: { steering: queueOf(steeringMsg) },
      options: {
        transformContext: async (msgs) => {
          seen.push(msgs.length);
          return msgs;
        }
      }
    });

    await new ContextTransformer().prepare(ctx);
    expect(seen).toEqual([1]);
  });
});

describe('TurnFinalizer (管线第 4 段)', () => {
  const msg = assistantMsg([]);

  it('工具要求终止时不续跑', async () => {
    const { ctx, events } = makeCtx();
    const cont = await new TurnFinalizer().finalize(ctx, {
      assistantMessage: msg,
      toolResults: [],
      shouldTerminateFromTools: true
    });
    expect(cont).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('turn_end');
  });

  it('shouldStopAfterTurn 返回真时不续跑', async () => {
    const { ctx } = makeCtx({
      options: { shouldStopAfterTurn: async () => true }
    });
    const cont = await new TurnFinalizer().finalize(ctx, {
      assistantMessage: msg,
      toolResults: [],
      shouldTerminateFromTools: false
    });
    expect(cont).toBe(false);
  });

  it('有工具结果时续跑，让模型处理结果', async () => {
    const { ctx } = makeCtx();
    const cont = await new TurnFinalizer().finalize(ctx, {
      assistantMessage: msg,
      toolResults: [{ role: 'toolResult' } as ToolResultMessage],
      shouldTerminateFromTools: false
    });
    expect(cont).toBe(true);
  });

  it('steering 队列非空时续跑', async () => {
    const { ctx } = makeCtx({
      queues: { steering: queueOf({ role: 'user', content: [], timestamp: 1 } as AgentMessage) }
    });
    const cont = await new TurnFinalizer().finalize(ctx, {
      assistantMessage: msg,
      toolResults: [],
      shouldTerminateFromTools: false
    });
    expect(cont).toBe(true);
  });

  it('follow-up 队列非空时排空并入历史后续跑', async () => {
    const followUpMsg = { role: 'user', content: [], timestamp: 5 } as AgentMessage;
    const { ctx, events, state } = makeCtx({
      queues: { followUp: queueOf(followUpMsg) }
    });
    const cont = await new TurnFinalizer().finalize(ctx, {
      assistantMessage: msg,
      toolResults: [],
      shouldTerminateFromTools: false
    });
    expect(cont).toBe(true);
    expect(state.messages).toContain(followUpMsg);
    expect(events.map((e) => e.type)).toEqual(['turn_end', 'message_start', 'message_end']);
  });

  it('无终止条件、无队列时停止', async () => {
    const { ctx } = makeCtx();
    const cont = await new TurnFinalizer().finalize(ctx, {
      assistantMessage: msg,
      toolResults: [],
      shouldTerminateFromTools: false
    });
    expect(cont).toBe(false);
  });

  it('工具结果优先于 steering：有工具结果时直接续跑，不再排 follow-up', async () => {
    const followUpMsg = { role: 'user', content: [], timestamp: 5 } as AgentMessage;
    const followUp = queueOf(followUpMsg);
    const steering = queueOf({ role: 'user', content: [], timestamp: 1 } as AgentMessage);
    const { ctx, state } = makeCtx({ queues: { followUp, steering } });

    const cont = await new TurnFinalizer().finalize(ctx, {
      assistantMessage: msg,
      toolResults: [{ role: 'toolResult' } as ToolResultMessage],
      shouldTerminateFromTools: false
    });

    expect(cont).toBe(true);
    expect(state.messages).not.toContain(followUpMsg);
  });
});

describe('ToolDispatcher (管线第 3 段)', () => {
  it('无工具调用时返回空结果且不触发任何事件', async () => {
    const { ctx, events } = makeCtx();
    const out = await new ToolDispatcher().dispatch(ctx, assistantMsg([{ type: 'text', text: 'hi' }]));
    expect(out).toEqual({ toolResults: [], shouldTerminate: false });
    expect(events).toHaveLength(0);
  });

  it('执行工具并把结果消息并入历史', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'echo',
      parameters: undefined,
      execute: async () => ({ content: [{ type: 'text', text: 'pong' }] })
    });

    const { ctx, events, state } = makeCtx({ toolRegistry: registry });
    const msg = assistantMsg([{ type: 'toolCall', id: 'c1', name: 'echo', arguments: {} } as any]);

    const out = await new ToolDispatcher().dispatch(ctx, msg);

    expect(out.shouldTerminate).toBe(false);
    expect(out.toolResults).toHaveLength(1);
    expect(out.toolResults[0].content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(state.messages).toContain(out.toolResults[0]);
    expect(events.map((e) => e.type)).toEqual([
      'tool_execution_start',
      'tool_execution_end',
      'message_start',
      'message_end'
    ]);
    expect(state.pendingToolCalls.size).toBe(0);
  });

  it('beforeToolCall 拦截时不执行工具，并按 terminate 标记终止', async () => {
    const execute = vi.fn();
    const registry = new ToolRegistry();
    registry.register({ name: 'boom', description: '', parameters: undefined, execute });

    const { ctx } = makeCtx({
      toolRegistry: registry,
      options: { beforeToolCall: async () => ({ block: true, reason: 'nope', terminate: true }) }
    });
    const msg = assistantMsg([{ type: 'toolCall', id: 'c1', name: 'boom', arguments: {} } as any]);

    const out = await new ToolDispatcher().dispatch(ctx, msg);

    expect(execute).not.toHaveBeenCalled();
    expect(out.shouldTerminate).toBe(true);
    expect(out.toolResults[0].isError).toBe(true);
    expect(out.toolResults[0].content).toEqual([{ type: 'text', text: 'nope' }]);
  });

  it('afterToolCall 可覆写内容与 isError，并能请求终止', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: '',
      parameters: undefined,
      execute: async () => ({ content: [{ type: 'text', text: 'raw' }] })
    });

    const { ctx } = makeCtx({
      toolRegistry: registry,
      options: {
        afterToolCall: async () => ({
          content: [{ type: 'text', text: 'rewritten' }],
          isError: true,
          terminate: true
        })
      }
    });
    const msg = assistantMsg([{ type: 'toolCall', id: 'c1', name: 'echo', arguments: {} } as any]);

    const out = await new ToolDispatcher().dispatch(ctx, msg);
    expect(out.toolResults[0].content).toEqual([{ type: 'text', text: 'rewritten' }]);
    expect(out.toolResults[0].isError).toBe(true);
    expect(out.shouldTerminate).toBe(true);
  });

  it('工具抛异常时由 ToolRegistry 收敛为错误结果（不触发终止，与既有语义一致）', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'bad',
      description: '',
      parameters: undefined,
      execute: async () => {
        throw new Error('kaboom');
      }
    });

    const { ctx, state } = makeCtx({ toolRegistry: registry });
    const msg = assistantMsg([{ type: 'toolCall', id: 'c1', name: 'bad', arguments: {} } as any]);

    const out = await new ToolDispatcher().dispatch(ctx, msg);
    expect(out.shouldTerminate).toBe(false);
    expect(out.toolResults[0].isError).toBe(true);
    expect(out.toolResults[0].content[0]).toMatchObject({ text: 'Tool Exception: kaboom' });
    expect(state.pendingToolCalls.size).toBe(0);
  });

  it('生命周期钩子抛异常时收敛为错误结果并请求终止', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: '',
      parameters: undefined,
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
    });

    const { ctx } = makeCtx({
      toolRegistry: registry,
      options: {
        beforeToolCall: async () => {
          throw new Error('hook exploded');
        }
      }
    });
    const msg = assistantMsg([{ type: 'toolCall', id: 'c1', name: 'echo', arguments: {} } as any]);

    const out = await new ToolDispatcher().dispatch(ctx, msg);
    expect(out.shouldTerminate).toBe(true);
    expect(out.toolResults[0].isError).toBe(true);
    expect(out.toolResults[0].content[0]).toMatchObject({
      text: 'Tool lifecycle error: hook exploded'
    });
  });

  it('signal 已中断时直接返回中断结果，不调用工具', async () => {
    const execute = vi.fn();
    const registry = new ToolRegistry();
    registry.register({ name: 'echo', description: '', parameters: undefined, execute });

    const { ctx } = makeCtx({ toolRegistry: registry });
    ctx.signal = { aborted: true } as AbortSignal;
    const msg = assistantMsg([{ type: 'toolCall', id: 'c1', name: 'echo', arguments: {} } as any]);

    const out = await new ToolDispatcher().dispatch(ctx, msg);
    expect(execute).not.toHaveBeenCalled();
    expect(out.toolResults[0].content).toEqual([{ type: 'text', text: 'Tool execution aborted by signal' }]);
    expect(out.shouldTerminate).toBe(false);
  });

  it('sequential 模式下按调用顺序串行执行', async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: '',
      parameters: undefined,
      execute: async (_id, args: any) => {
        order.push(`start:${args.n}`);
        await new Promise((r) => setTimeout(r, args.n === 1 ? 20 : 1));
        order.push(`end:${args.n}`);
        return { content: [{ type: 'text', text: String(args.n) }] };
      }
    });

    const { ctx } = makeCtx({ toolRegistry: registry, options: { toolExecution: 'sequential' } });
    const msg = assistantMsg([
      { type: 'toolCall', id: 'c1', name: 't', arguments: { n: 1 } } as any,
      { type: 'toolCall', id: 'c2', name: 't', arguments: { n: 2 } } as any
    ]);

    const out = await new ToolDispatcher().dispatch(ctx, msg);
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
    expect(out.toolResults.map((r) => (r.content[0] as any).text)).toEqual(['1', '2']);
  });

  it('parallel 模式下全部并发启动，结果顺序仍与调用顺序一致', async () => {
    let running = 0;
    let maxConcurrent = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: 't',
      description: '',
      parameters: undefined,
      execute: async (_id, args: any) => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise((r) => setTimeout(r, args.n === 1 ? 20 : 5));
        running -= 1;
        return { content: [{ type: 'text', text: String(args.n) }] };
      }
    });

    const { ctx } = makeCtx({ toolRegistry: registry, options: { toolExecution: 'parallel' } });
    const msg = assistantMsg([
      { type: 'toolCall', id: 'c1', name: 't', arguments: { n: 1 } } as any,
      { type: 'toolCall', id: 'c2', name: 't', arguments: { n: 2 } } as any
    ]);

    const out = await new ToolDispatcher().dispatch(ctx, msg);
    expect(maxConcurrent).toBe(2);
    expect(out.toolResults.map((r) => (r.content[0] as any).text)).toEqual(['1', '2']);
  });

  it('journal 会登记意图、结算与工具执行三条记录', async () => {
    const appended: Array<{ kind: string; payload: any }> = [];
    const journal = { append: (kind: string, payload: any) => appended.push({ kind, payload }) };

    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: '',
      parameters: undefined,
      execute: async () => ({ content: [{ type: 'text', text: 'pong' }] })
    });

    const { ctx } = makeCtx({ toolRegistry: registry, options: { journal } });
    const msg = assistantMsg([{ type: 'toolCall', id: 'c1', name: 'echo', arguments: { a: 1 } } as any]);

    await new ToolDispatcher().dispatch(ctx, msg);

    expect(appended.map((a) => a.kind)).toEqual(['operation_intent', 'operation_settlement', 'tool_execution']);
    expect(appended[0].payload).toMatchObject({ id: 'op_tool_c1', type: 'tool_call' });
  });
});

describe('extractToolCalls', () => {
  it('只取 toolCall，忽略 text / thinking', () => {
    const calls = extractToolCalls(
      assistantMsg([
        { type: 'text', text: 'x' },
        { type: 'toolCall', id: 'c1', name: 'a', arguments: {} },
        { type: 'thinking', thinking: 'y' },
        { type: 'toolCall', id: 'c2', name: 'b', arguments: {} }
      ] as any)
    );
    expect(calls.map((c) => c.id)).toEqual(['c1', 'c2']);
  });
});
