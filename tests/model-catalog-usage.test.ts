import { describe, it, expect } from 'vitest';
import {
  KNOWN_MODELS,
  findModelInCatalog,
  getThinkingBudgetForLevel,
  UsageTracker,
  retryAssistantStream
} from '@inkpi/ai';

describe('@inkpi/ai -> ModelCatalog, ThinkingBudgets & UsageTracker', () => {
  it('should find models and map thinking budgets correctly', () => {
    const dsReasoner = findModelInCatalog('deepseek-reasoner');
    expect(dsReasoner).toBeDefined();
    expect(dsReasoner?.provider).toBe('deepseek');
    expect(dsReasoner?.supportsThinking).toBe(true);

    expect(getThinkingBudgetForLevel('none')).toBe(0);
    expect(getThinkingBudgetForLevel('low')).toBe(1024);
    expect(getThinkingBudgetForLevel('medium')).toBe(4096);
    expect(getThinkingBudgetForLevel('high')).toBe(16384);
    expect(getThinkingBudgetForLevel('max')).toBe(32768);
  });

  it('should foreshadowing token usage and calculate USD costs accurately', () => {
    const foreshadowinger = new UsageTracker();

    foreshadowinger.recordUsage(
      {
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 200_000,
        totalTokens: 1_500_000
      },
      'deepseek-chat'
    );

    const totals = foreshadowinger.getTotals();
    expect(totals.inputTokens).toBe(1_000_000);
    expect(totals.outputTokens).toBe(500_000);
    expect(totals.cacheReadTokens).toBe(200_000);
    expect(totals.costUsd).toBeGreaterThan(0.2); // input: 0.14 + output: 0.14 + cacheRead: ~0.0028

    // Test model with no cache cost
    foreshadowinger.recordUsage(
      {
        inputTokens: 500_000,
        outputTokens: 100_000,
        cacheWriteTokens: 50_000,
        totalTokens: 650_000
      },
      'qwen2.5:14b'
    );

    // Test unknown model name and no model parameter
    foreshadowinger.recordUsage({ inputTokens: 100, outputTokens: 100, totalTokens: 200 }, 'unknown_model_123');
    foreshadowinger.recordUsage({ inputTokens: 50, outputTokens: 50, totalTokens: 100 });

    foreshadowinger.reset();
    expect(foreshadowinger.getTotals().totalTokens).toBe(0);
  });


  it('should execute retry with exponential backoff on transient errors', async () => {
    let callCount = 0;
    const retryFn = async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('Transient rate limit error');
      }
      return 'success-data';
    };

    const retryEvents: number[] = [];
    const result = await retryAssistantStream(retryFn, {
      maxRetries: 4,
      initialDelayMs: 5,
      maxDelayMs: 20,
      onRetry: (attempt) => retryEvents.push(attempt)
    });

    expect(result).toBe('success-data');
    expect(callCount).toBe(3);
    expect(retryEvents).toEqual([1, 2]);
  });
});
