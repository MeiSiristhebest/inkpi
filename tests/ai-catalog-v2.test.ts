import { AssistantEventStream, ModelCatalogV2, type ModelCatalogV2Entry } from '@inkpi/ai';
import { describe, expect, it, vi } from 'vitest';

function entry(overrides: Partial<ModelCatalogV2Entry> = {}): ModelCatalogV2Entry {
  return {
    id: 'vendor/creative-pro',
    name: 'Creative Pro',
    provider: 'test-provider',
    contextWindow: 32_000,
    maxTokens: 4_096,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
    cost: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    ...overrides
  };
}

describe('ModelCatalogV2', () => {
  it('does not implicitly load the legacy generated catalog', () => {
    expect(new ModelCatalogV2().getAllModels()).toEqual([]);
  });

  it('keeps duplicate provider short ids ambiguous and preserves OpenRouter ids', () => {
    const catalog = new ModelCatalogV2([
      entry({ id: 'openai/gpt-4o', provider: 'openrouter' }),
      entry({ id: 'anthropic/gpt-4o', provider: 'anthropic' })
    ]);

    expect(catalog.getRoute('openai/gpt-4o')?.modelId).toBe('openai/gpt-4o');
    expect(catalog.getModel('gpt-4o')).toBeUndefined();
  });

  it('separates canonical identity, aliases, route metadata, and authentication descriptors', () => {
    const catalog = new ModelCatalogV2([
      entry({
        canonicalId: 'inkpi/creative-pro-v2',
        aliases: ['legacy-pro', 'writer-pro'],
        route: {
          provider: 'test-provider',
          modelId: 'creative-pro-v2',
          baseUrl: 'http://127.0.0.1:9000/v1'
        },
        authentication: {
          kind: 'oauth',
          required: true,
          credentialRef: 'model:test-provider'
        },
        availability: { status: 'degraded', checkedAt: 10, reason: 'warm-up' }
      })
    ]);

    expect(catalog.getModel('legacy-pro')?.canonicalId).toBe('inkpi/creative-pro-v2');
    expect(catalog.getModel('writer-pro')?.canonicalId).toBe('inkpi/creative-pro-v2');
    expect(catalog.getIdentity('legacy-pro')).toMatchObject({
      canonicalId: 'inkpi/creative-pro-v2',
      name: 'Creative Pro'
    });
    expect(catalog.getPricing('legacy-pro')).toEqual({ inputPerMillionUsd: 1, outputPerMillionUsd: 2 });
    expect(catalog.getRoute('vendor/creative-pro')).toMatchObject({
      canonicalId: 'inkpi/creative-pro-v2',
      provider: 'test-provider',
      modelId: 'creative-pro-v2',
      baseUrl: 'http://127.0.0.1:9000/v1',
      authentication: { kind: 'oauth', required: true, credentialRef: 'model:test-provider' },
      availability: { status: 'degraded' },
      transport: { kind: 'custom', baseUrl: 'http://127.0.0.1:9000/v1' },
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 }
    });
    expect(catalog.getAliases()).toMatchObject({
      'legacy-pro': 'inkpi/creative-pro-v2',
      'writer-pro': 'inkpi/creative-pro-v2'
    });
  });

  it('resolves multiple operations through one identity, route, and credential reference', () => {
    const catalog = new ModelCatalogV2([
      entry({
        canonicalId: 'inkpi/writer-model',
        operations: ['chat', 'classify'],
        authentication: { kind: 'api-key', required: true, credentialRef: 'provider:shared-key' }
      })
    ]);

    const chat = catalog.resolveOperation('inkpi/writer-model', 'chat');
    const classify = catalog.resolveOperation('inkpi/writer-model', 'classify');
    expect(catalog.getOperations('inkpi/writer-model')).toEqual(['chat', 'classify']);
    expect(classify).toMatchObject({ operation: 'classify', canonicalId: chat.canonicalId });
    expect(classify.route.authentication).toEqual(chat.route.authentication);
    expect(() => catalog.resolveOperation('inkpi/writer-model', 'image')).toThrow(
      /does not support the 'image' operation/
    );
  });

  it('preserves tiered pricing as a defensive catalog copy', () => {
    const catalog = new ModelCatalogV2([
      entry({
        pricing: {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 2,
          serviceTierRates: { priority: { outputPerMillionUsd: 4 } },
          promptLengthTiers: [{ minimumPromptTokens: 128_000, rates: { inputPerMillionUsd: 3 } }],
          cacheWritePerMillionUsdByTtl: { '5m': 2, '1h': 5 }
        }
      })
    ]);

    const returnedPricing = catalog.getPricing('vendor/creative-pro')!;
    returnedPricing.serviceTierRates!.priority.outputPerMillionUsd = 99;
    returnedPricing.promptLengthTiers![0].rates.inputPerMillionUsd = 99;
    returnedPricing.cacheWritePerMillionUsdByTtl!['5m'] = 99;

    expect(catalog.getPricing('vendor/creative-pro')).toMatchObject({
      serviceTierRates: { priority: { outputPerMillionUsd: 4 } },
      promptLengthTiers: [{ minimumPromptTokens: 128_000, rates: { inputPerMillionUsd: 3 } }],
      cacheWritePerMillionUsdByTtl: { '5m': 2, '1h': 5 }
    });
    expect(catalog.getRoute('vendor/creative-pro')?.pricing?.serviceTierRates).toEqual({
      priority: { outputPerMillionUsd: 4 }
    });
  });

  it('rejects invalid tiered pricing before registration', () => {
    expect(
      () =>
        new ModelCatalogV2([
          entry({
            pricing: {
              inputPerMillionUsd: 1,
              outputPerMillionUsd: 2,
              promptLengthTiers: [
                { minimumPromptTokens: 128_000, rates: { inputPerMillionUsd: 3 } },
                { minimumPromptTokens: 128_000, rates: { outputPerMillionUsd: 4 } }
              ]
            }
          })
        ])
    ).toThrow(/thresholds must be unique/);
  });

  it('resolves executable handlers separately from catalog metadata', () => {
    const catalog = new ModelCatalogV2([entry()]);
    const handler = vi.fn(() => new AssistantEventStream());
    catalog.registerHandler('test-provider', handler);
    catalog.registerAlias('short-name', 'vendor/creative-pro');

    const resolved = catalog.resolveExecutableModel('short-name');
    expect(resolved.route.canonicalId).toBe('vendor/creative-pro');
    expect(resolved.config).toMatchObject({
      id: 'creative-pro',
      provider: 'test-provider'
    });
    expect(resolved.handler).toBe(handler);
  });

  it('updates availability without exposing or storing credentials', () => {
    const catalog = new ModelCatalogV2([entry({ provider: 'ollama', id: 'ollama/local' })]);
    expect(catalog.getRoute('ollama/local')?.authentication).toEqual({ kind: 'none', required: false });

    const returned = catalog.setAvailability('local', {
      status: 'available',
      checkedAt: 20
    });
    expect(returned).toEqual({ status: 'available', checkedAt: 20 });
    expect(catalog.getRoute('ollama/local')?.availability).toEqual({ status: 'available', checkedAt: 20 });
    expect(JSON.stringify(catalog.getRoute('ollama/local'))).not.toContain('apiKey');
  });

  it('rejects alias collisions and removes aliases with their model', () => {
    const catalog = new ModelCatalogV2([entry(), entry({ id: 'other/model', name: 'Other' })]);
    catalog.registerAlias('shared', 'vendor/creative-pro');
    expect(() => catalog.registerAlias('shared', 'other/model')).toThrow(/already mapped/);
    expect(() =>
      catalog.registerModel(entry({ id: 'third/model', canonicalId: 'third/model', aliases: ['vendor/creative-pro'] }))
    ).toThrow(/already mapped/);
    expect(catalog.getModel('vendor/creative-pro')?.id).toBe('vendor/creative-pro');

    expect(catalog.unregisterModel('vendor/creative-pro')).toBe(true);
    expect(catalog.getModel('shared')).toBeUndefined();
    expect(catalog.getModel('other/model')).toBeDefined();
  });
});
