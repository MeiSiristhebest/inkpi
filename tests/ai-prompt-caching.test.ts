import { describe, it, expect } from 'vitest';
import { streamAi, getModelPreset, UsageTracker, PromptCacheOptimizer } from '@inkpi/ai';

describe('AI Layer - Prompt Caching & Cost Calculation', () => {
  it('should stream with prompt caching enabled and capture cache token usage', async () => {
    const model = getModelPreset('mock-test');
    model.supportsPromptCache = true;

    const stream = streamAi(
      model,
      [{ role: 'user', content: '写一段长篇开头', timestamp: Date.now() }],
      { cacheControl: { type: 'ephemeral' }, thinkingBudget: 2000 }
    );

    const message = await stream.collect();
    expect(message.content.length).toBeGreaterThan(0);
    expect(message.usage).toBeDefined();
    expect(message.usage?.cacheReadTokens).toBe(30);
    expect(message.usage?.cacheWriteTokens).toBe(10);
    expect(message.usage?.reasoningTokens).toBe(20);
  });

  it('should calculate cost breakdown and cache savings accurately in UsageTracker', () => {
    const foreshadowinger = new UsageTracker();
    
    // Record usage for claude-3-7-sonnet
    foreshadowinger.recordUsage(
      {
        inputTokens: 20000,
        outputTokens: 4000,
        cacheReadTokens: 80000,
        cacheWriteTokens: 10000,
        totalTokens: 114000
      },
      'claude-3-7-sonnet'
    );

    const totals = foreshadowinger.getTotals();
    expect(totals.inputTokens).toBe(20000);
    expect(totals.cacheReadTokens).toBe(80000);
    expect(totals.totalTokens).toBe(114000);
    expect(totals.costUsd).toBeGreaterThan(0);

    const breakdown = foreshadowinger.getCostBreakdown('claude-3-7-sonnet');
    expect(breakdown.cacheHitRatio).toBe(0.8); // 80000 / 100000 = 80%
    expect(breakdown.savedCostByCache).toBeGreaterThan(0);
    expect(breakdown.totalCost).toBeCloseTo(totals.costUsd, 4);
  });

  it('should build cached prompt with prefix sections and compute savings in PromptCacheOptimizer', () => {
    const result = PromptCacheOptimizer.buildCachedPrompt({
      baseSystemPrompt: '你是一位作家助手',
      backgroundContext: '修仙世界背景设定',
      domainRules: '境界规则',
      stateLedger: {
        entities: [{ id: '1', name: '林动', status: 'active' }],
        assets: [{ id: '2', name: '石符', state: 'intact', holder: '林动' }] as any,
        tracks: [],
        locations: [],
        modifiedResources: []
      },
      currentTurnMessages: [{ role: 'user', content: '继续写' }]
    });

    expect(result.cachedSystemPrompt).toContain('修仙世界背景设定');
    expect(result.cachedSystemPrompt).toContain('林动');
    expect(result.estimatedPrefixTokens).toBeGreaterThan(0);
    expect(result.cacheControl.type).toBe('ephemeral');

    const savings = PromptCacheOptimizer.calculateSavings(100000, {
      inputPricePerMillion: 3.0,
      cacheReadPricePerMillion: 0.3
    });
    expect(savings.savedCostUsd).toBeGreaterThan(0);
    expect(savings.savingsPercentage).toBeCloseTo(90, 2);
  });
});
