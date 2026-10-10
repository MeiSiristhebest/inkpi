import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, ConversationContext, SessionCompactor } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import type { AgentMessage } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

function answer(): AssistantEventStream {
  const stream = new AssistantEventStream();
  stream.push({ type: 'text_delta', textDelta: 'answer' });
  stream.push({ type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
  stream.end();
  return stream;
}
function compactor(
  summarizer: (input: string, systemPrompt: string) => Promise<string> = async () => 'FACT: the key belongs to Lin',
  threshold = 1
): SessionCompactor {
  return new SessionCompactor({
    clock: () => 1,
    summarizer,
    triggerTokensThreshold: threshold,
    preserveRecentCount: 1
  });
}

describe('persisted conversation compaction', () => {
  it('uses the compacted model view after restart, retaining raw transcript, rules, usage, and as-of reads', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'inkpi-context-'));
    try {
      const filePath = join(directory, 'session.jsonl');
      const journal = new AppendOnlySessionJournal({ sessionId: 'compact', filePath });
      const requests: AgentMessage[][] = [];
      const agent = new Agent({
        initialState: { model: getModelPreset('mock-test'), systemPrompt: 'Do not change hard facts.' },
        journal,
        sessionCompactor: compactor(),
        streamFn: (_model, messages) => {
          requests.push(messages);
          return answer();
        }
      });
      await agent.prompt('Lin owns the key.');
      const before = agent.getModelContext().headId;
      await agent.prompt('Describe the key.');
      const history = requests[1].filter((message) => message.role !== 'system');
      expect(history).toHaveLength(2);
      expect(history[0].content).toEqual([
        { type: 'text', text: expect.stringContaining('FACT: the key belongs to Lin') }
      ]);
      expect(history[1]).toMatchObject({ role: 'user', content: 'Describe the key.' });
      expect(requests[1].find((message) => message.role === 'system')).toMatchObject({
        sections: { instructions: 'Do not change hard facts.' }
      });
      expect(agent.state.messages).toHaveLength(4);
      expect(agent.getModelContext().usageTotals.totalTokens).toBe(10);
      expect(agent.getModelContext(before).messages.filter((message) => message.role !== 'system')).toHaveLength(2);
      const restored = new Agent({
        initialState: { model: getModelPreset('mock-test') },
        journal: new AppendOnlySessionJournal({ sessionId: 'compact', filePath })
      });
      expect(restored.state.messages).toHaveLength(4);
      expect(restored.getModelContext().messages).toEqual(agent.getModelContext().messages);
      expect(restored.getModelContext().usageTotals.totalTokens).toBe(10);
      const summaryId = history[0].id!;
      await restored.editContext({ version: 1, edits: [{ action: 'exclude', messageId: summaryId }] });
      expect(restored.getModelContext().messages.some((message) => message.id === summaryId)).toBe(false);
      expect(restored.state.messages).toHaveLength(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects stale and cancelled summaries while preserving newly appended input', async () => {
    const journal = new AppendOnlySessionJournal('stale');
    journal.append('user_message', { content: 'old' });
    journal.append('user_message', { content: 'recent' });
    const context = new ConversationContext(journal, () => 1);
    const head = context.getHeadId();
    const result = await compactor().compact(context.getContext().messages);
    await context.append('user_message', { content: 'new input during summary' });
    expect(await context.commitCompaction(result, head)).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(await context.commitCompaction(result, context.getHeadId(), controller.signal)).toBe(false);
    expect(context.getContext().messages.at(-1)?.content).toBe('new input during summary');
    expect(journal.getEntriesByType('compaction')).toHaveLength(0);
  });

  it('excludes a failed overflow attempt from the retry but keeps its raw usage and audit record', async () => {
    const journal = new AppendOnlySessionJournal('overflow');
    const requests: AgentMessage[][] = [];
    let summaries = '';
    const agent = new Agent({
      initialState: {
        model: getModelPreset('mock-test'),
        messages: [
          { role: 'user', content: 'old facts' },
          { role: 'assistant', content: [{ type: 'text', text: 'prior answer' }] }
        ]
      },
      journal,
      sessionCompactor: compactor(async (input) => {
        summaries = input;
        return 'old facts retained';
      }, 100000),
      streamFn: (_model, messages) => {
        requests.push(messages);
        if (requests.length === 1) {
          const stream = new AssistantEventStream();
          stream.push({ type: 'usage', usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 } });
          stream.error({ message: 'failed overflow attempt', code: 'context_overflow' });
          return stream;
        }
        return answer();
      }
    });
    await agent.prompt('newest input');
    expect(requests).toHaveLength(2);
    expect(summaries).not.toContain('failed overflow attempt');
    expect(
      requests[1].some((message) => message.role === 'assistant' && message.providerError?.code === 'context_overflow')
    ).toBe(false);
    expect(requests[1].at(-1)).toMatchObject({ role: 'user', content: 'newest input' });
    expect(
      agent.state.messages.some(
        (message) => message.role === 'assistant' && message.providerError?.code === 'context_overflow'
      )
    ).toBe(true);
    expect(agent.getModelContext().usageTotals.totalTokens).toBe(13);
    expect(journal.getEntriesByType('context_edit')).toHaveLength(1);
  });

  it('does not summarize the only input or retry a single oversized user message', async () => {
    let calls = 0;
    let summaries = 0;
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      journal: new AppendOnlySessionJournal('single'),
      sessionCompactor: compactor(async () => {
        summaries++;
        return 'summary';
      }),
      streamFn: () => {
        calls++;
        const stream = new AssistantEventStream();
        stream.error({ message: 'overflow', code: 'context_overflow' });
        return stream;
      }
    });
    await agent.prompt('oversized'.repeat(100));
    expect(calls).toBe(1);
    expect(summaries).toBe(0);
    expect(agent.getModelContext().messages.filter((message) => message.role !== 'system')).toEqual([
      expect.objectContaining({ role: 'user' })
    ]);
  });

  it('compacts according to the selected model capacity and includes structured instruction tokens', async () => {
    const summarizer = compactor(async () => 'summary', 100000);
    const requests: AgentMessage[][] = [];
    const agent = new Agent({
      initialState: {
        model: { ...getModelPreset('mock-test')!, contextWindow: 40, maxTokens: 10 },
        systemPrompt: 'rules'.repeat(20),
        messages: [
          { role: 'user', content: 'old' },
          { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
        ]
      },
      journal: new AppendOnlySessionJournal('budget'),
      sessionCompactor: summarizer,
      streamFn: (_model, messages) => {
        requests.push(messages);
        return answer();
      }
    });
    await agent.prompt('new input');
    expect(requests[0].filter((message) => message.role !== 'system')).toHaveLength(2);
    expect(
      summarizer.estimateMessageTokens({ role: 'system', content: '', sections: { rules: 'long'.repeat(50) } })
    ).toBeGreaterThan(50);
  });

  it('keeps a tool call and its results together at the compaction boundary', () => {
    const history: AgentMessage[] = [
      { id: 'call', role: 'assistant', content: [{ type: 'toolCall', id: 't', name: 'lookup', arguments: {} }] },
      {
        id: 'result',
        role: 'toolResult',
        toolCallId: 't',
        toolName: 'lookup',
        content: [{ type: 'text', text: 'data' }]
      }
    ];
    expect(compactor().canCompact(history)).toBe(false);
  });
});
