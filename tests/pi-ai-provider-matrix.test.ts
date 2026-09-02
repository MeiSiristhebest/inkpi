import { describe, it, expect } from 'vitest';
import {
  ModelCatalogManager,
  KNOWN_MODELS,
  findModelInCatalog,
  getThinkingBudgetForLevel,
  streamAi,
  registerProvider,
  createFauxProvider
} from '@inkpi/ai';

describe('Pi AI Multi-Provider Matrix & Catalog Discovery', () => {
  it('should discover and filter models through ModelCatalogManager', async () => {
    const manager = new ModelCatalogManager();
    expect(manager.getAllModels().length).toBeGreaterThanOrEqual(KNOWN_MODELS.length);

    // Filter by provider
    const deepseekModels = manager.filterByProvider('deepseek');
    expect(deepseekModels.length).toBeGreaterThanOrEqual(2);
    expect(deepseekModels.some((m) => m.id === 'deepseek-chat')).toBe(true);

    const geminiModels = manager.filterByProvider('gemini');
    expect(geminiModels.length).toBeGreaterThanOrEqual(1);

    // Filter by capabilities
    const thinkingModels = manager.filterByCapability({ thinking: true });
    expect(thinkingModels.length).toBeGreaterThan(0);

    // Dynamic registration
    manager.registerModel({
      id: 'custom-author-model',
      name: 'Custom Author FineTune',
      provider: 'custom',
      contextWindow: 65536,
      maxTokens: 4096,
      supportsThinking: false,
      supportsTools: true,
      cost: { inputPerMillionUsd: 1.0, outputPerMillionUsd: 2.0 }
    });

    expect(manager.getModel('custom-author-model')).toBeDefined();
  });

  it('should resolve thinking budget correctly for all levels', () => {
    expect(getThinkingBudgetForLevel('none')).toBe(0);
    expect(getThinkingBudgetForLevel('low')).toBe(1024);
    expect(getThinkingBudgetForLevel('medium')).toBe(4096);
    expect(getThinkingBudgetForLevel('high')).toBe(16384);
    expect(getThinkingBudgetForLevel('xhigh')).toBe(24576);
    expect(getThinkingBudgetForLevel('max')).toBe(32768);
  });

  it('should stream AI responses with thinking extraction and usage stats', async () => {
    registerProvider('custom', createFauxProvider({
      thinking: 'thinking fixture',
      text: 'text fixture',
      inputTokens: 5,
      outputTokens: 7
    }));
    const model = findModelInCatalog('deepseek-reasoner') || KNOWN_MODELS[0];
    const stream = streamAi(
      {
        id: model.id,
        name: model.name,
        provider: 'custom',
        supportsThinking: true
      },
      [{ role: 'user', content: '构思修真剧情' }]
    );

    const events: string[] = [];
    stream.on((ev) => {
      events.push(ev.type);
    });

    const assistantMsg = await stream.collect();
    expect(assistantMsg.role).toBe('assistant');
    expect(events).toContain('thinking_delta');
    expect(events).toContain('text_delta');
    expect(events).toContain('usage');
    expect(assistantMsg.usage?.totalTokens).toBeGreaterThan(0);
  });

  it('should foreshadowing token usage breakdown and prompt caching savings with UsageTracker', async () => {
    const { UsageTracker } = await import('@inkpi/ai');
    const foreshadowinger = new UsageTracker();

    foreshadowinger.recordUsage({
      inputTokens: 10000,
      outputTokens: 2000,
      totalTokens: 12000,
      cacheReadTokens: 5000,
      cacheWriteTokens: 1000
    }, 'claude-3-7-sonnet');

    const breakdown = foreshadowinger.getCostBreakdown('claude-3-7-sonnet');
    expect(breakdown.totalCost).toBeGreaterThan(0);
    expect(breakdown.savedCostByCache).toBeGreaterThan(0);
    expect(breakdown.cacheHitRatio).toBeGreaterThan(0);

    // Test non-existent model breakdown fallback
    const fallbackBreakdown = foreshadowinger.getCostBreakdown('unknown-model');
    expect(fallbackBreakdown.totalCost).toBe(0);

    // Test catalog refresh
    const manager = new ModelCatalogManager([]);
    const refreshed = await manager.refreshCatalog(async () => [
      {
        id: 'refreshed-model',
        name: 'Refreshed',
        provider: 'openai',
        contextWindow: 128000,
        maxTokens: 4096,
        supportsThinking: false,
        supportsTools: true,
        cost: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
        recommendedFor: 'prose'
      }
    ]);
    expect(refreshed.length).toBe(1);
    expect(manager.unregisterModel('refreshed-model')).toBe(true);
  });
});
