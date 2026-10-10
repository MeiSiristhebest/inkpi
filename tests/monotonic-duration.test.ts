import { Agent, ToolRegistry, reduceSession } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import type { AgentEvent, AgentTool, AssistantMessage } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

describe('monotonic request and tool durations', () => {
  it('times direct streams until completion, independently of collection time', async () => {
    let now = 10;
    const stream = new AssistantEventStream(() => now);
    stream.push({ type: 'text_delta', textDelta: 'answer' });
    now = 18;
    stream.end();
    now = 100;
    expect((await stream.collect()).durationMs).toBe(8);
  });

  it('excludes request and tool hooks and survives wall-clock changes and recovery', async () => {
    let elapsed = 0;
    let wall = 10_000;
    const journal = new AppendOnlySessionJournal({ sessionId: 'duration', clock: () => wall });
    const events: AgentEvent[] = [];
    const tool: AgentTool = {
      name: 'lookup',
      description: 'lookup',
      parameters: { type: 'object' },
      execute: async () => {
        elapsed += 9;
        wall = 3000;
        return { content: [{ type: 'text', text: 'result' }] };
      }
    };
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test'), tools: [tool] },
      journal,
      clock: () => wall,
      monotonicClock: () => elapsed,
      prepareRequest: () => {
        elapsed += 50;
        return undefined;
      },
      beforeToolCall: async () => {
        elapsed += 40;
        return undefined;
      },
      afterToolCall: async () => {
        elapsed += 100;
        return undefined;
      },
      finishTurn: () => {
        elapsed += 70;
        return { action: 'end' };
      },
      streamFn: () => {
        const stream = new AssistantEventStream(() => elapsed);
        stream.push({ type: 'tool_call_start', toolCallId: 'call', toolName: 'lookup' });
        stream.push({
          type: 'tool_call_end',
          toolCall: { type: 'toolCall', id: 'call', name: 'lookup', arguments: {} }
        });
        elapsed += 8;
        stream.end();
        return stream;
      }
    });
    agent.subscribe((event) => {
      events.push(event);
    });
    await agent.prompt('lookup');
    expect((agent.state.messages.find((message) => message.role === 'assistant') as AssistantMessage).durationMs).toBe(
      8
    );
    expect(agent.state.messages.find((message) => message.role === 'toolResult')).toMatchObject({
      durationMs: 9,
      timestamp: 3000
    });
    expect(events.find((event) => event.type === 'tool_execution_end')).toMatchObject({ durationMs: 9 });
    expect(reduceSession(journal.getEntries()).messages.filter((message) => message.role !== 'user')).toMatchObject([
      { durationMs: 8 },
      { durationMs: 9 }
    ]);
  });

  it('does not time a missing, invalid, or cancelled tool and does time a thrown execute', async () => {
    let elapsed = 0;
    const registry = new ToolRegistry(
      () => 1,
      () => elapsed
    );
    registry.register({
      name: 'lookup',
      description: 'lookup',
      parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
      execute: async () => {
        elapsed += 7;
        throw new Error('failure');
      }
    });
    const call = { type: 'toolCall' as const, id: 'call', name: 'lookup', arguments: { query: 'query' } };
    for (const result of [
      await registry.executeTool({ ...call, name: 'missing' }),
      await registry.executeTool({ ...call, arguments: {} }),
      await registry.executeTool(call, AbortSignal.abort())
    ]) {
      expect(result.isError).toBe(true);
      expect(result).not.toHaveProperty('durationMs');
    }
    expect(await registry.executeTool(call)).toMatchObject({ isError: true, durationMs: 7 });
  });
});
