import { Agent, ConversationContext, SessionCompactor, reduceSession } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import type { AgentMessage } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());
function answer(): AssistantEventStream {
  const stream = new AssistantEventStream();
  stream.push({ type: 'text_delta', textDelta: 'answer' });
  stream.end();
  return stream;
}

describe('incremental persisted conversation projection', () => {
  it.each([1000, 10000])('scans only newly committed entries in a %i-entry conversation', async (count) => {
    const journal = new AppendOnlySessionJournal('scan');
    journal.appendBatch(
      Array.from({ length: count }, (_, index) => ({
        type: 'user_message' as const,
        id: `message-${index}`,
        payload: { content: `chapter ${index}` }
      }))
    );
    const conversation = new ConversationContext(journal, () => 1);
    expect(conversation.getContext().messages).toHaveLength(count);
    expect(conversation.getCacheStats()).toEqual({ scannedEntries: count, rebuilds: 1, cachedEntries: count });
    const firstHead = conversation.getHeadId();
    for (let index = 0; index < 10; index++) {
      await conversation.appendBatch([
        { type: 'user_message', payload: { content: `next ${index}` } },
        { type: 'operation_intent', payload: { id: `op-${index}`, type: 'provider_stream' } },
        {
          type: 'agent_turn',
          payload: {
            content: [{ type: 'text', text: `answer ${index}` }],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }
          }
        }
      ]);
      conversation.getContext();
      conversation.getContext();
    }
    expect(conversation.getCacheStats().scannedEntries).toBe(count + 30);
    expect(conversation.getContext().usageTotals.totalTokens).toBe(30);
    await conversation.append('context_edit', { version: 1, edits: [{ action: 'exclude', messageId: 'message-0' }] });
    expect(conversation.getModelMessages()).toHaveLength(count + 19);
    expect(conversation.getCacheStats().scannedEntries).toBe(count + 31);
    const branchHead = conversation.getHeadId();
    conversation.selectHead(firstHead);
    await conversation.append('user_message', { content: 'other branch' });
    expect(conversation.getContext().messages).toHaveLength(count + 1);
    const scans = conversation.getCacheStats().scannedEntries;
    expect(conversation.getContext(branchHead).messages).toHaveLength(count + 19);
    conversation.getContext();
    expect(conversation.getCacheStats().scannedEntries).toBe(scans + count + 31);
    conversation.clearCache();
    expect(conversation.getCacheStats().cachedEntries).toBe(0);
    expect(conversation.getContext().messages.at(-1)?.content).toBe('other branch');
  });

  it('matches raw replay for interleaved settlements and protects cached state from external references', async () => {
    const journal = new AppendOnlySessionJournal('replay');
    const conversation = new ConversationContext(journal, () => 1);
    for (let turn = 0; turn < 20; turn++) {
      await conversation.append('user_message', { content: `input ${turn}` });
      await conversation.append('agent_turn', {
        content: [{ type: 'toolCall', id: `slow-${turn}`, name: 'lookup', arguments: {} }]
      });
      await conversation.append('operation_settlement', { id: `fast-${turn}`, state: 'settled' });
      await conversation.append('tool_execution', {
        toolCallId: `fast-${turn}`,
        toolName: 'lookup',
        result: 'fast',
        sourceIndex: 1
      });
      expect(conversation.getContext().rawMessages).toEqual(reduceSession(conversation.getPath()).messages);
      await conversation.append('operation_settlement', { id: `slow-${turn}`, state: 'settled' });
      await conversation.append('tool_execution', {
        toolCallId: `slow-${turn}`,
        toolName: 'lookup',
        result: 'slow',
        sourceIndex: 0
      });
      await conversation.append('agent_turn', {
        content: [{ type: 'text', text: 'finished' }],
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
      });
      expect(conversation.getContext().rawMessages).toEqual(reduceSession(conversation.getPath()).messages);
    }
    const external = conversation.getContext();
    (external.rawMessages[0] as { content: unknown }).content = 'mutated';
    external.messages.length = 0;
    external.usageTotals.totalTokens = -1;
    const current = conversation.getContext();
    expect(current.rawMessages[0].content).toBe('input 0');
    expect(current.messages).toHaveLength(100);
    expect(current.usageTotals.totalTokens).toBe(100);
  });

  it('feeds real incremental callbacks only new model messages and resets on context edits and branch changes', async () => {
    const updates: Array<{ reset: boolean; messages: AgentMessage[] }> = [];
    const journal = new AppendOnlySessionJournal('callback');
    const agent = new Agent({
      journal,
      initialState: { model: getModelPreset('mock-test') },
      streamFn: () => answer(),
      incrementalTransformContext: (update) => {
        updates.push({ reset: update.reset, messages: structuredClone([...update.messages]) });
        return update.reset ? [...update.messages] : [...update.previousView, ...update.messages];
      }
    });
    await agent.prompt('first');
    const head = agent.getModelContext().headId;
    const userId = agent.state.messages[0].id!;
    await agent.prompt('second');
    expect(updates.map((update) => update.reset)).toEqual([true, false]);
    expect(updates[1].messages.map((message) => message.role)).toEqual(['assistant', 'user']);
    await agent.editContext({ version: 1, edits: [{ action: 'exclude', messageId: userId }] });
    await agent.prompt('third');
    expect(updates[2].reset).toBe(true);
    expect(updates[2].messages.some((message) => message.id === userId)).toBe(false);
    await agent.selectContextHead(head);
    await agent.prompt('different branch');
    expect(updates[3].reset).toBe(true);
    expect(updates[3].messages.some((message) => message.role === 'user' && message.content === 'second')).toBe(false);
  });

  it('retains the projection while busy and releases it after five idle minutes', async () => {
    vi.useFakeTimers();
    const journal = new AppendOnlySessionJournal('retention');
    const conversation = new ConversationContext(journal, () => 1);
    const held = new AssistantEventStream();
    let calls = 0;
    const agent = new Agent({
      journal,
      conversation,
      initialState: { model: getModelPreset('mock-test') },
      streamFn: () => (++calls === 2 ? held : answer())
    });
    await agent.prompt('first');
    const scanned = conversation.getCacheStats().scannedEntries;
    await vi.advanceTimersByTimeAsync(299999);
    expect(conversation.getCacheStats().cachedEntries).toBeGreaterThan(0);
    const busy = agent.prompt('held request');
    await vi.advanceTimersByTimeAsync(300001);
    expect(conversation.getCacheStats().cachedEntries).toBeGreaterThan(0);
    held.push({ type: 'text_delta', textDelta: 'released answer' });
    held.end();
    await busy;
    await vi.advanceTimersByTimeAsync(300000);
    expect(conversation.getCacheStats().cachedEntries).toBe(0);
    await agent.prompt('after idle');
    expect(conversation.getCacheStats().scannedEntries).toBeGreaterThan(scanned);
    expect(conversation.getCacheStats().rebuilds).toBeGreaterThan(1);
  });

  it('rejects a summary generated for an earlier model configuration without discarding input', async () => {
    const journal = new AppendOnlySessionJournal('changed-model');
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const compactor = new SessionCompactor({
      clock: () => 1,
      triggerTokensThreshold: 1,
      preserveRecentCount: 1,
      summarizer: async () => {
        started();
        await gate;
        return 'old model summary';
      }
    });
    const agent = new Agent({
      journal,
      sessionCompactor: compactor,
      initialState: {
        model: { ...getModelPreset('mock-test')!, contextWindow: 10, maxTokens: 2 },
        messages: [{ role: 'user', content: 'old facts' }]
      },
      streamFn: () => answer()
    });
    const run = agent.prompt('fresh input');
    await began;
    agent.state.model = { ...agent.state.model!, id: 'different-model' };
    release();
    await run;
    expect(journal.getEntriesByType('compaction')).toHaveLength(0);
    expect(
      agent.getModelContext().messages.some((message) => message.role === 'user' && message.content === 'fresh input')
    ).toBe(true);
  });
});
