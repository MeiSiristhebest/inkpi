import { describe, it, expect } from 'vitest';
import {
  KNOWN_MODELS,
  findModelInCatalog,
  getThinkingBudgetForLevel,
  getModelPreset,
  modelCatalogEntryToConfig,
  PromptCacheOptimizer,
  UsageTracker,
  calculateCost,
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
    expect(getThinkingBudgetForLevel('xhigh')).toBe(24576);
    expect(getThinkingBudgetForLevel('max')).toBe(32768);
    expect(getThinkingBudgetForLevel('invalid' as any)).toBe(0);

    const config = modelCatalogEntryToConfig(dsReasoner!);
    expect(config.id).toBe(dsReasoner!.id);
  });

  it('should keep faux test fixtures out of the production model catalog', () => {
    expect(KNOWN_MODELS.some((model) => model.provider === 'faux')).toBe(false);
    expect(KNOWN_MODELS.some((model) => model.id === 'mock-model-v1')).toBe(false);
    expect(findModelInCatalog('mock-model-v1')).toBeUndefined();
    expect(getModelPreset('mock-test').provider).toBe('faux');
  });

  it('should test getModelPreset across preset names', () => {
    expect(getModelPreset('creative-pro').id).toBe('deepseek-chat');
    expect(getModelPreset('creative-fast').id).toBe('deepseek-chat');
    expect(getModelPreset('creative-local').id).toBe('qwen2.5:14b');
    expect(getModelPreset('deep-reasoning').id).toBe('deepseek-reasoner');
    expect(getModelPreset('fast-draft').id).toBe('deepseek-chat');
    expect(getModelPreset('local-offline').id).toBe('qwen2.5:14b');
    expect(getModelPreset('mock-test').id).toBe('mock-model-v1');
    expect(() => getModelPreset('unknown-preset')).toThrow(/Unknown model preset/);
  });

  it('should foreshadowing token usage and calculate USD costs accurately', () => {
    const foreshadowinger = new UsageTracker();

    // When empty
    const emptyBreakdown = foreshadowinger.getCostBreakdown('unknown-model');
    expect(emptyBreakdown.totalCost).toBe(0);
    expect(emptyBreakdown.cacheHitRatio).toBe(0);

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

    const breakdown = foreshadowinger.getCostBreakdown('deepseek-chat');
    expect(breakdown.totalCost).toBeGreaterThan(0);
    expect(breakdown.cacheHitRatio).toBeGreaterThan(0);

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

  it('should test PromptCacheOptimizer helper branches', () => {
    const prompt1 = PromptCacheOptimizer.buildCachedPrompt({
      baseSystemPrompt: '系统指令',
      currentTurnMessages: []
    });
    expect(prompt1.cachedSystemPrompt).toContain('系统指令');
    expect(prompt1.estimatedPrefixTokens).toBeGreaterThan(0);

    const prompt2 = PromptCacheOptimizer.buildCachedPrompt({
      baseSystemPrompt: '指令',
      domainRules: '规则',
      backgroundContext: '背景',
      stateLedger: {
        entities: [{ id: '1', name: '林动', status: 'active', attributes: {} }],
        assets: [{ id: '2', name: '石符', holder: '林动', state: 'intact' } as any],
        locations: [],
        tracks: [],
        modifiedResources: []
      },
      currentTurnMessages: []
    });
    expect(prompt2.cachedSystemPrompt).toContain('规则');
    expect(prompt2.cachedSystemPrompt).toContain('林动[active]');

    const savings = PromptCacheOptimizer.calculateSavings(50000, {
      inputPricePerMillion: 3,
      cacheReadPricePerMillion: 0.3
    });
    expect(savings.savedCostUsd).toBeGreaterThan(0);
    expect(savings.savingsPercentage).toBeGreaterThan(0);

    const zeroSavings = PromptCacheOptimizer.calculateSavings(0, {
      inputPricePerMillion: 0,
      cacheReadPricePerMillion: 0
    });
    expect(zeroSavings.savingsPercentage).toBe(0);
  });

  it('should test calculateCost helper function directly', () => {
    const cost1 = calculateCost({ inputPerMillionUsd: 1, outputPerMillionUsd: 2 }, { inputTokens: 1000, outputTokens: 500 });
    expect(cost1).toBeGreaterThan(0);

    const cost2 = calculateCost(
      { inputPerMillionUsd: 1, outputPerMillionUsd: 2, cacheReadPerMillionUsd: 0.1, cacheWritePerMillionUsd: 0.2 },
      { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50 }
    );
    expect(cost2).toBeGreaterThan(0);

    const costEmpty = calculateCost({ inputPerMillionUsd: 1, outputPerMillionUsd: 2 }, {});
    expect(costEmpty).toBe(0);
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
