import { SessionCompactor } from '@inkpi/agent-core';
import type { AgentMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import type { SummaryGenerationRequest } from '../packages/agent-core/src/compaction/summarize.js';

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
    let summaryRequest: SummaryGenerationRequest | undefined;
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
          summaryTokens: 10,
          summaryInputTokens: 20
        }
      },
      summarizer: async (_input, _systemPrompt, request) => {
        summaryRequest = request;
        return '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      }
    });
    const task = { kind: 'writing', contextPolicy: { maxTokens: 200 } };
    const budget = compactor.resolveBudget(task);

    expect(budget).toMatchObject({
      contextWindowTokens: 80,
      outputReserveTokens: 20,
      triggerTokensThreshold: 60,
      preserveRecentCount: 1,
      preserveRecentTokens: 25,
      summaryTokens: 10,
      summaryInputTokens: 20
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
    expect(result.summaryBudget).toMatchObject({
      maxInputTokens: 20,
      estimatedInputTokens: expect.any(Number),
      visibleSummaryTokens: 10
    });
    expect(result.entry.summary.length).toBeLessThanOrEqual(10);
    expect(result.compactedMessages[0]).not.toHaveProperty('usage');
    expect(summaryRequest).toMatchObject({
      maxInputTokens: 20,
      taskKind: 'writing'
    });
    expect(summaryRequest?.maxOutputTokens).toBeUndefined();
    expect(summaryRequest?.contextWindowTokens).toBeUndefined();
    expect(summaryRequest?.remainingContextTokens).toBeUndefined();
    expect(result.entry.firstKeptEntryId).toBe('m5');
    expect(result.compactedMessages.at(-2)).toMatchObject({ id: 'm5' });
    expect(result.compactedMessages.at(-1)).toMatchObject({ id: 'm6' });
  });

  it('snapshots per-task budgets so caller mutation cannot change the active compactor policy', async () => {
    const reviewBudget = { summaryInputTokens: 40, summaryOutputTokens: 30 };
    let summaryRequest: SummaryGenerationRequest | undefined;
    const compactor = new SessionCompactor({
      clock: () => 1,
      preserveRecentCount: 1,
      taskBudgets: { review: reviewBudget },
      summarizer: async (_input, _systemPrompt, request) => {
        summaryRequest = request;
        return 'brief';
      }
    });
    reviewBudget.summaryInputTokens = 4;

    const result = await compactor.compact(
      [
        { id: 'old', role: 'user', content: 'old context' },
        { id: 'recent', role: 'user', content: 'recent context' }
      ],
      undefined,
      { kind: 'review' }
    );

    expect(summaryRequest?.maxInputTokens).toBe(40);
    expect(summaryRequest?.maxOutputTokens).toBe(30);
    expect(result.budget.summaryInputTokens).toBe(40);
  });

  it('uses the known summary context remainder as an output cap without a legacy length setting', async () => {
    let summaryRequest: SummaryGenerationRequest | undefined;
    const compactor = new SessionCompactor({
      clock: () => 1,
      charsPerToken: 1,
      summaryInputTokens: 2_000,
      summaryContextWindowTokens: 2_000,
      preserveRecentCount: 1,
      summarizer: async (_input, _systemPrompt, request) => {
        summaryRequest = request;
        return 'brief';
      }
    });

    await compactor.compact([
      { id: 'old', role: 'user', content: 'old context' },
      { id: 'recent', role: 'user', content: 'recent context' }
    ]);

    expect(summaryRequest?.remainingContextTokens).toBeGreaterThan(0);
    expect(summaryRequest?.maxOutputTokens).toBe(summaryRequest?.remainingContextTokens);
  });

  it('passes known summarizer budgets and usage without inferring them from the target task window', async () => {
    let summaryRequest: SummaryGenerationRequest | undefined;
    const compactor = new SessionCompactor({
      clock: () => 1,
      charsPerToken: 1,
      summaryInputTokens: 80,
      summaryOutputTokens: 90,
      summaryContextWindowTokens: 1_200,
      preserveRecentCount: 1,
      taskBudgets: {
        review: {
          summaryInputTokens: 40,
          summaryOutputTokens: 30,
          summaryContextWindowTokens: 1_000
        }
      },
      summarizer: async (_input, _systemPrompt, request) => {
        summaryRequest = request;
        return {
          text: 'Short summary',
          usage: { inputTokens: 18, outputTokens: 4, totalTokens: 22 }
        };
      }
    });
    const controller = new AbortController();
    const messages: AgentMessage[] = [
      { id: 'old-user', role: 'user', content: 'Keep this old fact.' },
      { id: 'old-assistant', role: 'assistant', content: [{ type: 'text', text: 'Old answer.' }] },
      { id: 'recent', role: 'user', content: 'Keep this recent request.' }
    ];

    const result = await compactor.compact(messages, controller.signal, {
      kind: 'review',
      contextPolicy: { maxTokens: 5 }
    });

    expect(summaryRequest).toMatchObject({
      signal: controller.signal,
      maxInputTokens: 40,
      maxOutputTokens: 30,
      contextWindowTokens: 1_000,
      taskKind: 'review'
    });
    expect(summaryRequest?.estimatedInputTokens).toBeGreaterThan(0);
    expect(summaryRequest?.remainingContextTokens).toBeGreaterThan(0);
    expect(result.compactedMessages[0]).toMatchObject({
      role: 'assistant',
      usage: { inputTokens: 18, outputTokens: 4, totalTokens: 22 }
    });
    expect(result.budget).toMatchObject({
      contextWindowTokens: 5,
      summaryInputTokens: 40,
      summaryOutputTokens: 30,
      summaryContextWindowTokens: 1_000
    });
    expect(result.summaryBudget).toMatchObject({
      maxInputTokens: 40,
      estimatedInputTokens: expect.any(Number),
      contextWindowTokens: 1_000,
      remainingContextTokens: expect.any(Number),
      maxOutputTokens: 30
    });
  });

  it('preserves grapheme boundaries when applying the legacy visible-summary ceiling', async () => {
    const generatedSummary = `${'👩🏽‍💻e\u0301 — '.repeat(20)}LATEST FACT`;
    const compactor = new SessionCompactor({
      clock: () => 1,
      charsPerToken: 1,
      summaryTokens: 100,
      preserveRecentCount: 1,
      summarizer: async () => generatedSummary
    });

    const result = await compactor.compact([
      { id: 'old', role: 'user', content: 'old context' },
      { id: 'recent', role: 'user', content: 'recent context' }
    ]);
    const summary = result.entry.summary;

    expect(summary.length).toBeLessThanOrEqual(100);
    expect(summary).toContain('SUMMARY OUTPUT: original=');
    expect(summary).toContain('👩🏽‍💻e\u0301');
    expect(summary).toContain('LATEST FACT');
    expect(() => encodeURIComponent(summary)).not.toThrow();
    expect(summary).not.toMatch(/e…|…\p{Mark}|\u200d…|…\u200d/u);
  });

  it('rejects a summary that exceeds an explicit generation budget instead of clipping it', async () => {
    const compactor = new SessionCompactor({
      clock: () => 1,
      charsPerToken: 1,
      summaryOutputTokens: 3,
      preserveRecentCount: 1,
      summarizer: async () => ({
        text: 'ok',
        usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 2, totalTokens: 5 }
      })
    });

    await expect(
      compactor.compact([
        { id: 'old', role: 'user', content: 'old message' },
        { id: 'recent', role: 'user', content: 'recent message' }
      ])
    ).rejects.toThrow('exceeded the configured generation output budget');
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
