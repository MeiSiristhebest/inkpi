import { describe, it, expect } from 'vitest';
import {
  GENERATED_MODELS,
  findGeneratedModel,
  listGeneratedModelsByProvider,
  calculateCost
} from '../packages/ai/src/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.join(__dirname, '..');

describe('AI Model Catalog Generation & Hydration Suite (1:1 Aligned with Pi)', () => {
  it('should verify generated model data JSON and TypeScript definitions exist and match schema', () => {
    const jsonPath = path.join(packageRoot, 'packages', 'ai', 'src', 'models-data.json');
    const tsPath = path.join(packageRoot, 'packages', 'ai', 'src', 'models.generated.ts');

    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(tsPath)).toBe(true);

    const rawJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    expect(Array.isArray(rawJson)).toBe(true);
    expect(rawJson.length).toBeGreaterThanOrEqual(15);
  });

  it('should verify comprehensive model metadata including Context Window, Pricing, Vision, and Thinking', () => {
    // DeepSeek V3
    const dsV3 = findGeneratedModel('deepseek-chat');
    expect(dsV3).toBeDefined();
    expect(dsV3?.provider).toBe('deepseek');
    expect(dsV3?.contextWindow).toBeGreaterThanOrEqual(65536);
    expect(dsV3?.cost.inputPerMillionUsd).toBeGreaterThanOrEqual(0.14);

    // DeepSeek R1
    const dsR1 = findGeneratedModel('deepseek-reasoner');
    expect(dsR1).toBeDefined();
    expect(dsR1?.supportsThinking).toBe(true);

    // Claude 3.7 Sonnet
    const claudeSonnet = findGeneratedModel('claude-3-7-sonnet');
    expect(claudeSonnet).toBeDefined();
    expect(claudeSonnet?.supportsVision).toBe(true);
    expect(claudeSonnet?.supportsThinking).toBe(true);
    expect(claudeSonnet?.contextWindow).toBeGreaterThanOrEqual(200000);

    // Gemini 2.5 Pro (1 Million Context)
    const geminiPro = findGeneratedModel('gemini-2.5-pro');
    expect(geminiPro).toBeDefined();
    expect(geminiPro?.contextWindow).toBeGreaterThanOrEqual(1000000);
    expect(geminiPro?.supportsVision).toBe(true);
  });

  it('should filter models by provider and calculate token usage cost accurately', () => {
    const anthropicModels = listGeneratedModelsByProvider('claude');
    expect(anthropicModels.length).toBeGreaterThanOrEqual(3);
    expect(anthropicModels.every((m) => m.provider === 'claude')).toBe(true);

    const sonnet = findGeneratedModel('claude-3-5-sonnet') || findGeneratedModel('claude-3.5-sonnet')!;

    const usage = {
      inputTokens: 100000, // 0.1M * $3.0 = $0.30
      outputTokens: 20000,  // 0.02M * $15.0 = $0.30
      cacheReadTokens: 50000, // 0.05M * $0.3 = $0.015
      cacheWriteTokens: 10000, // 0.01M * $3.75 = $0.0375
      totalTokens: 180000
    };

    const cost = calculateCost(
      {
        inputPerMillionUsd: sonnet.cost.inputPerMillionUsd,
        outputPerMillionUsd: sonnet.cost.outputPerMillionUsd,
        cacheReadPerMillionUsd: sonnet.cost.cacheReadPerMillionUsd,
        cacheWritePerMillionUsd: sonnet.cost.cacheWritePerMillionUsd
      },
      usage
    );

    // Total = 0.30 + 0.30 + 0.015 + 0.0375 = 0.6525
    expect(cost).toBeCloseTo(0.6525, 4);
  });

  it('should test ModelCatalogManager dynamic registration, filtering and capability querying', async () => {
    const { ModelCatalogManager, findModelInCatalog } = await import('../packages/ai/src/index.js');
    const manager = new ModelCatalogManager();

    expect(manager.getAllModels().length).toBeGreaterThan(10);

    // Filtering by capability
    const visionModels = manager.filterByCapability({ vision: true });
    expect(visionModels.length).toBeGreaterThan(0);
    expect(visionModels.every((m) => m.supportsVision)).toBe(true);

    const thinkingModels = manager.filterByCapability({ thinking: true });
    expect(thinkingModels.length).toBeGreaterThan(0);
    expect(thinkingModels.every((m) => m.supportsThinking)).toBe(true);

    // Custom model registration
    manager.registerModel({
      id: 'custom-novel-gpt-5',
      name: 'Custom Creative GPT 5',
      provider: 'custom',
      contextWindow: 128000,
      maxTokens: 8192,
      supportsThinking: true,
      supportsTools: true,
      cost: { inputPerMillionUsd: 1.0, outputPerMillionUsd: 2.0 }
    });

    expect(manager.getModel('custom-novel-gpt-5')).toBeDefined();
    expect(manager.unregisterModel('custom-novel-gpt-5')).toBe(true);
    expect(manager.unregisterModel('non-existent-model')).toBe(false);

    // Dynamic catalog refresh
    await manager.refreshCatalog(async () => [
      {
        id: 'refreshed-live-model-v1',
        name: 'Live Refreshed Model',
        provider: 'custom',
        contextWindow: 65536,
        maxTokens: 4096,
        supportsThinking: false,
        supportsTools: true,
        cost: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.2 }
      }
    ]);

    expect(manager.getModel('refreshed-live-model-v1')).toBeDefined();

    // Edge cases in findModelInCatalog
    expect(findModelInCatalog('')).toBeUndefined();
    expect(findModelInCatalog('deepseek-chat')).toBeDefined();
    expect(findModelInCatalog('deepseek/deepseek-chat')).toBeDefined();
    expect(findModelInCatalog('deepseek-reasoner')).toBeDefined();
    expect(findModelInCatalog('deepseek/deepseek-reasoner')).toBeDefined();
  });
});

