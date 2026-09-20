import { SessionCompactor } from '@inkpi/agent-core';
import type { AgentMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('task-aware compaction budgets', () => {
  it('accounts for system, tool, custom, and structured result content', () => {
    const compactor = new SessionCompactor({ clock: () => 1, charsPerToken: 1 });
    const messages: AgentMessage[] = [
      { id: 'system', role: 'system', content: 'system instructions' },
      {
        id: 'assistant',
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'search',
            arguments: { query: 'important context', limit: 3 }
          }
        ]
      },
      {
        id: 'tool',
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'search',
        content: [{ type: 'text', text: 'search result' }],
        details: { source: 'workspace', matches: ['one', 'two'] }
      },
      { id: 'custom', role: 'custom', customType: 'checkpoint', content: { step: 2, ok: true } }
    ];

    expect(compactor.estimateMessageTokens(messages[0])).toBeGreaterThan(1);
    expect(compactor.estimateMessageTokens(messages[1])).toBeGreaterThan(20);
    expect(compactor.estimateMessageTokens(messages[2])).toBeGreaterThan(20);
    expect(compactor.estimateTokens(messages)).toBeGreaterThan(80);
  });

  it('resolves per-task windows, output reserves, and recent-tail floors', async () => {
    const compactor = new SessionCompactor({
      clock: () => 1,
      charsPerToken: 1,
      triggerTokensThreshold: 1000,
      contextWindowTokens: 500,
      outputReserveTokens: 50,
      preserveRecentCount: 1,
      taskBudgets: {
        writing: {
          contextWindowTokens: 80,
          outputReserveTokens: 20,
          preserveRecentTokens: 25,
          summaryTokens: 10
        }
      },
      summarizer: async () => '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    });
    const task = { kind: 'writing', contextPolicy: { maxTokens: 200 } };
    const budget = compactor.resolveBudget(task);

    expect(budget).toMatchObject({
      contextWindowTokens: 80,
      outputReserveTokens: 20,
      triggerTokensThreshold: 60,
      preserveRecentCount: 1,
      preserveRecentTokens: 25,
      summaryTokens: 10
    });

    const messages: AgentMessage[] = [
      { id: 'm1', role: 'user', content: 'old context one' },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'old context two' }] },
      { id: 'm3', role: 'user', content: 'old context three' },
      { id: 'm4', role: 'assistant', content: [{ type: 'text', text: 'old context four' }] },
      { id: 'm5', role: 'user', content: 'recent context five XXXXX' },
      { id: 'm6', role: 'assistant', content: [{ type: 'text', text: 'recent context six XXXXX' }] }
    ];

    expect(compactor.shouldCompact(messages, task)).toBe(true);
    const result = await compactor.compact(messages, undefined, task);

    expect(result.budget).toEqual(budget);
    expect(result.entry.summary.length).toBeLessThanOrEqual(10);
    expect(result.entry.firstKeptEntryId).toBe('m5');
    expect(result.compactedMessages.at(-2)).toMatchObject({ id: 'm5' });
    expect(result.compactedMessages.at(-1)).toMatchObject({ id: 'm6' });
  });

  it('compacts a hard-overflowing short task even when the count guard would not trigger', () => {
    const compactor = new SessionCompactor({
      clock: () => 1,
      charsPerToken: 1,
      contextWindowTokens: 20,
      outputReserveTokens: 5,
      preserveRecentCount: 4
    });

    expect(
      compactor.shouldCompact([
        { id: 'm1', role: 'user', content: 'a very large first message' },
        { id: 'm2', role: 'user', content: 'a very large second message' }
      ])
    ).toBe(true);
  });

  it('uses a task context policy when no task-kind override exists', () => {
    const compactor = new SessionCompactor({ clock: () => 1, outputReserveTokens: 12 });
    expect(compactor.resolveBudget({ kind: 'review', contextPolicy: { maxTokens: 64 } })).toMatchObject({
      contextWindowTokens: 64,
      outputReserveTokens: 12,
      triggerTokensThreshold: 52
    });
  });
});
