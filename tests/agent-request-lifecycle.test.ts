import { Agent, SessionCompactor } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import type { AgentEvent, AgentTool } from '@inkpi/protocol';
import { describe, expect, it, vi } from 'vitest';

function response(text = 'answer'): AssistantEventStream {
  const stream = new AssistantEventStream();
  stream.push({ type: 'text_delta', textDelta: text });
  stream.end();
  return stream;
}

describe('agent request and turn lifecycle', () => {
  it('prepares the first request without replacing the audit transcript', async () => {
    const provider = vi.fn(() => response());
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test'), systemPrompt: 'old rule' },
      prepareRequest: (request) => {
        expect(request.messages).toMatchObject([{ role: 'user', content: 'original' }]);
        return {
          messages: [{ role: 'user', content: 'canonical view' }],
          systemPrompt: 'new rule',
          tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }]
        };
      },
      streamFn: provider
    });
    await agent.prompt('original');
    expect(provider.mock.calls[0]).toMatchObject([
      { id: getModelPreset('mock-test').id },
      [{ role: 'user', content: 'canonical view' }],
      { systemPrompt: 'new rule', tools: [{ name: 'lookup' }] }
    ]);
    expect(agent.state.messages[0]).toMatchObject({ content: 'original' });
  });

  it('continues exactly once without manufacturing another input message', async () => {
    const prepare = vi.fn();
    const provider = vi.fn(() => response());
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      prepareRequest: prepare,
      streamFn: provider,
      finishTurn: () => ({ action: provider.mock.calls.length === 1 ? 'continue' : 'end' })
    });
    await agent.prompt('original');
    expect(provider).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(agent.state.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
  });

  it('uses tool, steering, and follow-up scheduling to satisfy continue', async () => {
    let requests = 0;
    const tool: AgentTool = {
      name: 'lookup',
      description: 'lookup',
      parameters: { type: 'object' },
      execute: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'found' }] }))
    };
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test'), tools: [tool] },
      streamFn: () => {
        if (++requests !== 1) return response();
        const stream = new AssistantEventStream();
        stream.push({ type: 'tool_call_start', toolCallId: 'call', toolName: 'lookup' });
        stream.push({
          type: 'tool_call_end',
          toolCall: { type: 'toolCall', id: 'call', name: 'lookup', arguments: {} }
        });
        stream.end();
        return stream;
      },
      finishTurn: () => {
        if (requests === 1) {
          agent.steer({ role: 'user', content: 'steering' });
          agent.followUp({ role: 'user', content: 'follow-up' });
          return { action: 'continue' };
        }
      }
    });
    await agent.prompt('original');
    expect(requests).toBe(3);
    expect(tool.execute).toHaveBeenCalledTimes(1);
    expect(agent.state.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(
      ['original', 'steering', 'follow-up']
    );
  });

  it.each(['error', 'aborted'] as const)('runs finishTurn but hard-exits a %s response', async (reason) => {
    const provider = vi.fn(() => {
      const stream = new AssistantEventStream();
      if (reason === 'error') stream.error('failed');
      else stream.abort();
      return stream;
    });
    const oldStop = vi.fn(async () => false);
    const finish = vi.fn(() => {
      agent.followUp({ role: 'user', content: 'queued' });
      return { action: 'continue' as const };
    });
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      streamFn: provider,
      finishTurn: finish,
      shouldStopAfterTurn: oldStop
    });
    await agent.prompt('original');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(oldStop).not.toHaveBeenCalled();
    expect(agent.clearQueues()).toEqual({ steering: 0, followUp: 1 });
  });

  it('ends without consuming queues and rejects reentrant runs inside the hook', async () => {
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      streamFn: () => response(),
      finishTurn: async () => {
        agent.steer({ role: 'user', content: 'later steering' });
        agent.followUp({ role: 'user', content: 'later follow-up' });
        await expect(agent.continue()).rejects.toThrow('run in progress');
        return { action: 'end' };
      }
    });
    await agent.prompt('original');
    expect(agent.clearQueues()).toEqual({ steering: 1, followUp: 1 });
    expect(agent.isIdle).toBe(true);
  });

  it('settles before the hook and emits turn_end even when the hook fails', async () => {
    const order: string[] = [];
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      streamFn: () => response(),
      journal: { append: (type: string) => order.push(type) },
      finishTurn: () => {
        order.push('finish');
        throw new Error('hook failed');
      }
    });
    agent.subscribe((event: AgentEvent) => {
      order.push(event.type);
    });
    await expect(agent.prompt('original')).rejects.toThrow('hook failed');
    expect(order.indexOf('agent_turn')).toBeLessThan(order.indexOf('finish'));
    expect(order.indexOf('finish')).toBeLessThan(order.indexOf('turn_end'));
    expect(order.at(-1)).toBe('agent_end');
    expect(agent.isIdle).toBe(true);
  });

  it('prepares both the initial request and the overflow recovery request', async () => {
    const prepare = vi.fn();
    let requests = 0;
    const compactor = new SessionCompactor({ clock: () => 1, summarizer: async () => 'summary' });
    const agent = new Agent({
      initialState: {
        model: getModelPreset('mock-test'),
        messages: [{ role: 'user', content: 'previous context to compact' }]
      },
      sessionCompactor: compactor,
      prepareRequest: prepare,
      streamFn: () => {
        if (++requests > 1) return response();
        const stream = new AssistantEventStream();
        stream.error({ message: 'too large', code: 'context_overflow' });
        return stream;
      }
    });
    await agent.prompt('original');
    expect(requests).toBe(2);
    expect(prepare).toHaveBeenCalledTimes(2);
  });
});
