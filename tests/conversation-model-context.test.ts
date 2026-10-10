import { Agent } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset, getProvider, resolveModelTranscript, setHttpClient } from '@inkpi/ai';
import type { StreamOptions } from '@inkpi/ai';
import type { AgentMessage, AgentTool, ModelToolDefinition, SystemMessage } from '@inkpi/protocol';
import { InkPiDaemon } from '@inkpi/server';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => setHttpClient(null));
function answer(text = 'answer'): AssistantEventStream {
  const stream = new AssistantEventStream();
  stream.push({ type: 'text_delta', textDelta: text });
  stream.push({ type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
  stream.end();
  return stream;
}
function tool(name: string, field: string): AgentTool {
  return {
    name,
    description: `${name} ${field}`,
    parameters: { type: 'object', properties: { [field]: { type: 'string' } } },
    execute: async () => ({ content: [{ type: 'text', text: field }] })
  };
}

describe('canonical persisted model views', () => {
  it('excludes and replaces request history while retaining raw messages and original usage', async () => {
    const journal = new AppendOnlySessionJournal('view');
    const requests: AgentMessage[][] = [];
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test'), systemPrompt: 'rules' },
      journal,
      incrementalTransformContext: ({ messages, previousView, reset }) =>
        reset ? [...messages] : [...previousView, ...messages],
      streamFn: (_model, messages) => {
        requests.push(structuredClone(messages));
        return answer();
      }
    });
    await agent.prompt('original');
    const userId = agent.state.messages[0].id!;
    const assistantId = agent.state.messages[1].id!;
    const originalHead = agent.getModelContext().headId;
    const replacement: AgentMessage = { role: 'user', content: 'replacement' };
    await agent.editContext({
      version: 1,
      edits: [
        { action: 'replace', messageId: userId, message: replacement },
        { action: 'exclude', messageId: assistantId }
      ]
    });
    replacement.content = 'external mutation';
    await agent.prompt('next');
    expect(requests[1].filter((message) => message.role !== 'system').map((message) => message.content)).toEqual([
      'replacement',
      'next'
    ]);
    expect(agent.state.messages[0].content).toBe('original');
    expect(agent.state.messages).toHaveLength(4);
    expect(agent.getModelContext().usageTotals).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
    expect(agent.getModelContext(originalHead).messages.filter((message) => message.role !== 'system')).toHaveLength(2);
    expect(journal.getEntriesByType('context_edit')).toHaveLength(1);
    const restarted = new Agent({ initialState: { model: getModelPreset('mock-test') }, journal });
    expect(restarted.state.systemPrompt).toBe('rules');
    expect(restarted.getModelContext().messages.find((message) => message.id === userId)?.content).toBe('replacement');
    expect(restarted.getModelContext().messages.some((message) => message.id === assistantId)).toBe(false);
  });

  it('records loadout changes and restores branch rules and executable tool interfaces', async () => {
    const journal = new AppendOnlySessionJournal('loadout');
    const requests: Array<{ messages: AgentMessage[]; options?: StreamOptions }> = [];
    const originalTool = tool('lookup', 'old');
    const removed = tool('remove-me', 'query');
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test'), systemPrompt: 'first rules', tools: [originalTool, removed] },
      journal,
      streamFn: (_model, messages, options) => {
        requests.push({
          messages: structuredClone(messages),
          options: structuredClone(options && { ...options, signal: undefined })
        });
        return answer();
      }
    });
    agent.getToolRegistry().register(originalTool, { source: 'trusted-lookup', capabilities: ['read'] });
    await agent.prompt('first input');
    const firstHead = agent.getModelContext().headId!;
    agent.state.systemPrompt = 'second rules';
    agent.getToolRegistry().register(tool('lookup', 'new'));
    agent.getToolRegistry().unregister('remove-me');
    await agent.prompt('other branch');
    const secondHead = agent.getModelContext().headId!;
    const changes = requests[1].messages.filter((message) => message.role === 'system') as SystemMessage[];
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({
      sections: { instructions: 'second rules' },
      toolsRemoved: [{ name: 'remove-me' }]
    });
    expect(changes[1].toolsAdded?.[0].parameters).toHaveProperty('properties.new');
    await agent.selectContextHead(firstHead);
    expect(agent.state.systemPrompt).toBe('first rules');
    expect(agent.getToolRegistry().get('lookup')).toBe(originalTool);
    expect(agent.getToolRegistry().getRegistration('lookup')).toMatchObject({
      source: 'trusted-lookup',
      capabilities: ['read']
    });
    expect(agent.getToolRegistry().get('remove-me')).toBe(removed);
    await agent.prompt('new branch');
    expect(requests[2].messages.some((message) => message.role === 'user' && message.content === 'other branch')).toBe(
      false
    );
    expect(requests[2].options?.tools?.map((tool) => tool.name)).toEqual(['lookup', 'remove-me']);
    expect(
      agent
        .getModelContext(secondHead)
        .rawMessages.some((message) => message.role === 'user' && message.content === 'other branch')
    ).toBe(true);
    expect(journal.getEntriesByType('user_message')).toHaveLength(3);
    const restored = new Agent({ initialState: { model: getModelPreset('mock-test') }, journal });
    expect(
      restored.state.messages.some((message) => message.role === 'user' && message.content === 'other branch')
    ).toBe(false);
    expect(restored.state.systemPrompt).toBe('first rules');
  });

  it('rejects off-branch edits, role changes, and missing historical tools before writing', async () => {
    const journal = new AppendOnlySessionJournal('guards');
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test'), tools: [tool('lookup', 'query')] },
      journal,
      streamFn: () => answer()
    });
    await agent.prompt('first');
    const firstHead = agent.getModelContext().headId!;
    await agent.prompt('second');
    const offBranch = agent.state.messages[2].id!;
    await agent.selectContextHead(firstHead);
    const count = journal.count();
    await expect(
      agent.editContext({ version: 1, edits: [{ action: 'exclude', messageId: offBranch }] })
    ).rejects.toThrow('not on this conversation path');
    await expect(
      agent.editContext({
        version: 1,
        edits: [
          { action: 'replace', messageId: agent.state.messages[0].id!, message: { role: 'assistant', content: [] } }
        ]
      })
    ).rejects.toThrow('preserve the message role');
    expect(journal.count()).toBe(count);
    expect(agent.state.isFaulted).not.toBe(true);
    const restored = new Agent({ initialState: { model: getModelPreset('mock-test') }, journal });
    await expect(restored.selectContextHead(firstHead)).rejects.toThrow('Historical tool');
    expect(journal.count()).toBe(count);
  });

  it('preserves edits in a durable session fork and exposes as-of context through RPC', async () => {
    const daemon = new InkPiDaemon({ defaultModel: getModelPreset('mock-test') });
    const sessions = daemon.getSessionManager();
    const source = sessions.createSession({ sessionId: 'source' });
    await source.agent.prompt('source input');
    const id = source.agent.state.messages[1].id!;
    await source.agent.editContext({ version: 1, edits: [{ action: 'exclude', messageId: id }] });
    const fork = sessions.forkSession('source', { sessionId: 'fork' });
    expect(fork.agent.getModelContext().messages.some((message) => message.id === id)).toBe(false);
    expect(fork.agent.getModelContext().rawMessages.some((message) => message.id === id)).toBe(true);
    const result = await daemon
      .getRpcServer()
      .handleRequest({ jsonrpc: '2.0', id: 1, method: 'session.context.read', params: { sessionId: 'fork' } });
    expect(result.error).toBeUndefined();
    expect((result.result as { rawMessages: AgentMessage[] }).rawMessages).toHaveLength(2);
    await daemon.stop();
  });
});

describe('canonical tool result ordering', () => {
  it('preserves source order when result settlements interleave in completion order', async () => {
    const journal = new AppendOnlySessionJournal('parallel-view');
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let requests = 0;
    let id = 0;
    const agent = new Agent({
      journal,
      idGenerator: () => `parallel-${++id}`,
      initialState: {
        model: getModelPreset('mock-test'),
        tools: [
          {
            ...tool('slow', 'query'),
            execute: async () => {
              await slowGate;
              return { content: [{ type: 'text', text: 'slow result' }] };
            }
          },
          { ...tool('fast', 'query'), execute: async () => ({ content: [{ type: 'text', text: 'fast result' }] }) }
        ]
      },
      streamFn: () => {
        if (++requests > 1) return answer();
        const stream = new AssistantEventStream();
        for (const name of ['slow', 'fast']) {
          stream.push({ type: 'tool_call_start', toolCallId: name, toolName: name });
          stream.push({ type: 'tool_call_end', toolCall: { type: 'toolCall', id: name, name, arguments: {} } });
        }
        stream.end();
        return stream;
      }
    });
    agent.subscribe((event) => {
      if (event.type === 'tool_execution_end' && event.toolCallId === 'fast') releaseSlow();
    });
    await agent.prompt('lookup');
    expect(journal.getEntriesByType('tool_execution').map((entry) => entry.payload.toolName)).toEqual(['fast', 'slow']);
    expect(
      agent
        .getModelContext()
        .rawMessages.filter((message) => message.role === 'toolResult')
        .map((message) => message.toolName)
    ).toEqual(['slow', 'fast']);
    const restored = new Agent({ initialState: { model: getModelPreset('mock-test') }, journal });
    expect(
      restored.state.messages.filter((message) => message.role === 'toolResult').map((message) => message.toolName)
    ).toEqual(['slow', 'fast']);
  });
});

describe('provider instruction history capabilities', () => {
  const declaration: ModelToolDefinition = { name: 'lookup', description: 'lookup', parameters: { type: 'object' } };
  const messages: AgentMessage[] = [
    { role: 'system', content: '', sections: { rules: 'first rules' }, toolsAdded: [declaration] },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    { role: 'system', content: '', sections: { rules: 'second rules' }, toolsRemoved: [{ name: 'lookup' }] },
    { role: 'user', content: 'next' }
  ];

  it('folds named sections and removed tools for APIs without positioned instructions', () => {
    const resolved = resolveModelTranscript(messages);
    expect(resolved.options?.systemPrompt).toBe('second rules');
    expect(resolved.options?.tools).toEqual([]);
    expect(resolved.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect((messages[0] as SystemMessage).sections?.rules).toBe('first rules');
  });

  it('keeps the existing request prefix unchanged for an explicitly capable API', () => {
    const first = resolveModelTranscript(messages.slice(0, 3), undefined, true);
    const next = resolveModelTranscript(messages, undefined, true);
    expect(next.messages.slice(0, 3)).toEqual(first.messages);
    expect(next.messages[3]).toMatchObject({ role: 'system', content: expect.stringContaining('second rules') });
    expect(next.options?.tools).toEqual([]);
  });

  it.each(['openai', 'claude', 'gemini', 'ollama'] as const)(
    'folds the actual %s request payload',
    async (provider) => {
      let payload: Record<string, unknown> = {};
      setHttpClient({
        fetch: async (_url, init) => {
          payload = JSON.parse(String(init?.body));
          return new Response('fixture', { status: 400 });
        }
      });
      await getProvider(provider)(
        { provider, id: 'fixture', name: 'fixture', apiKey: 'fixture', baseUrl: 'https://fixture.invalid' },
        messages
      ).collect();
      const serialized = JSON.stringify(payload);
      expect(serialized).toContain('second rules');
      expect(serialized).not.toContain('first rules');
      expect(serialized).not.toContain('"name":"lookup"');
    }
  );
});
