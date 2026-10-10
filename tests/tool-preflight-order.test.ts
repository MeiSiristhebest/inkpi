import { Agent } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import type { AgentTool, ToolResultMessage } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function calls(names: string[]): AssistantEventStream {
  const stream = new AssistantEventStream();
  for (const name of names) {
    stream.push({ type: 'tool_call_start', toolCallId: name, toolName: name });
    stream.push({
      type: 'tool_call_end',
      toolCall: { type: 'toolCall', id: name, name, arguments: { query: 'original' } }
    });
  }
  stream.end();
  return stream;
}
function tool(name: string, execute: AgentTool['execute']): AgentTool {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    execute
  };
}
function text(value: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: value }] };
}

describe('tool preflight boundary', () => {
  it('finishes gates in source order before starting any parallel execution', async () => {
    const firstGate = gate();
    const secondGate = gate();
    const enteredFirst = gate();
    const enteredSecond = gate();
    const events: string[] = [];
    const agent = new Agent({
      initialState: {
        model: getModelPreset('mock-test'),
        tools: ['first', 'second'].map((name) =>
          tool(name, async () => {
            events.push(`execute:${name}`);
            return text(name);
          })
        )
      },
      streamFn: () => calls(['first', 'second']),
      finishTurn: () => ({ action: 'end' }),
      beforeToolCall: async ({ toolCall }) => {
        events.push(`before:${toolCall.name}`);
        if (toolCall.name === 'first') {
          enteredFirst.release();
          await firstGate.promise;
        } else {
          enteredSecond.release();
          await secondGate.promise;
        }
        return undefined;
      }
    });
    const run = agent.prompt('go');
    await enteredFirst.promise;
    await Promise.resolve();
    expect(events).toEqual(['before:first']);
    firstGate.release();
    await enteredSecond.promise;
    expect(events).toEqual(['before:first', 'before:second']);
    secondGate.release();
    await run;
    expect(events).toEqual(['before:first', 'before:second', 'execute:first', 'execute:second']);
  });

  it('keeps blocked and failed gates non-replayable, and does not record an execution duration', async () => {
    const journal = new AppendOnlySessionJournal('gates');
    const executed: string[] = [];
    const agent = new Agent({
      journal,
      clock: () => 1,
      initialState: {
        model: getModelPreset('mock-test'),
        tools: ['allowed', 'blocked', 'broken'].map((name) =>
          tool(name, async () => {
            executed.push(name);
            return text(name);
          })
        )
      },
      streamFn: () => calls(['allowed', 'blocked', 'broken']),
      finishTurn: () => ({ action: 'end' }),
      beforeToolCall: async ({ toolCall }) => {
        if (toolCall.name === 'blocked') return { block: true, reason: 'permission denied' };
        if (toolCall.name === 'broken') throw new Error('gate failed');
      }
    });
    await agent.prompt('go');
    expect(executed).toEqual(['allowed']);
    const results = agent.state.messages.filter((message) => message.role === 'toolResult') as ToolResultMessage[];
    expect(new Set(results.map((result) => result.id)).size).toBe(3);
    expect(results[1]).toMatchObject({ isError: true, content: [{ type: 'text', text: 'permission denied' }] });
    expect(results[2]).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Tool lifecycle error: gate failed' }]
    });
    expect(results[1].durationMs).toBeUndefined();
    expect(results[2].durationMs).toBeUndefined();
    const intents = journal.getEntriesByType('operation_intent').filter((entry) => entry.payload.type === 'tool_call');
    expect(intents.map((entry) => entry.payload.replay)).toEqual(['safe', 'never', 'never']);
  });

  it('allows a gate to observe cancellation and settles the entire batch without executing tools', async () => {
    const entered = gate();
    const execute = vi.fn(async () => text('unexpected'));
    const agent = new Agent({
      journal: new AppendOnlySessionJournal('cancel-gate'),
      initialState: { model: getModelPreset('mock-test'), tools: [tool('first', execute), tool('second', execute)] },
      streamFn: () => calls(['first', 'second']),
      beforeToolCall: async (_context, signal) => {
        entered.release();
        await new Promise<void>((resolve) => {
          signal!.addEventListener('abort', () => resolve(), { once: true });
        });
        return undefined;
      }
    });
    const run = agent.prompt('go');
    await entered.promise;
    await agent.abort();
    await run;
    expect(execute).not.toHaveBeenCalled();
    expect(agent.isIdle).toBe(true);
    expect(agent.state.messages.filter((message) => message.role === 'toolResult')).toHaveLength(2);
  });

  it('protects raw calls and actual arguments from mutations in gate callbacks', async () => {
    const received: unknown[] = [];
    const agent = new Agent({
      journal: new AppendOnlySessionJournal('gate-mutation'),
      initialState: {
        model: getModelPreset('mock-test'),
        tools: [
          tool('lookup', async (_id, args) => {
            received.push(args);
            return text('found');
          })
        ]
      },
      streamFn: () => calls(['lookup']),
      finishTurn: () => ({ action: 'end' }),
      beforeToolCall: async ({ args, toolCall, assistantMessage, context }) => {
        (args as { query: string }).query = 'mutated';
        toolCall.arguments.query = 'also mutated';
        assistantMessage.content.length = 0;
        (context as { messages: unknown[] }).messages.length = 0;
        return undefined;
      }
    });
    await agent.prompt('go');
    expect(received).toEqual([{ query: 'original' }]);
    expect(agent.state.messages[1]).toMatchObject({ content: [{ arguments: { query: 'original' } }] });
    expect(agent.getModelContext().rawMessages).toHaveLength(3);
  });

  it('waits for async result observers before publishing source-ordered history and becoming idle', async () => {
    const slow = gate();
    const observedFast = gate();
    const consumer = gate();
    const journal = new AppendOnlySessionJournal('consumer');
    const order: string[] = [];
    const agent = new Agent({
      journal,
      clock: () => 1,
      initialState: {
        model: getModelPreset('mock-test'),
        tools: [
          tool('slow', async () => {
            await slow.promise;
            return text('slow');
          }),
          tool('fast', async () => text('fast'))
        ]
      },
      streamFn: () => calls(['slow', 'fast']),
      finishTurn: () => ({ action: 'end' })
    });
    agent.subscribe(async (event) => {
      if (event.type === 'tool_execution_end') {
        order.push(event.toolCallId);
        if (event.toolCallId === 'fast') {
          observedFast.release();
          await consumer.promise;
          slow.release();
        }
      }
    });
    const run = agent.prompt('go');
    await observedFast.promise;
    expect(agent.isIdle).toBe(false);
    expect(agent.state.messages.filter((message) => message.role === 'toolResult')).toHaveLength(0);
    expect(journal.getEntriesByType('tool_execution')).toHaveLength(1);
    consumer.release();
    await run;
    expect(order).toEqual(['fast', 'slow']);
    expect(
      agent.state.messages.filter((message) => message.role === 'toolResult').map((message) => message.toolName)
    ).toEqual(['slow', 'fast']);
    expect(agent.isIdle).toBe(true);
  });
});
