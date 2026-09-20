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
    expect(catalog.getRoute('vendor/creative-pro')).toMatchObject({
      canonicalId: 'inkpi/creative-pro-v2',
      provider: 'test-provider',
      modelId: 'creative-pro-v2',
      baseUrl: 'http://127.0.0.1:9000/v1',
      authentication: { kind: 'oauth', required: true, credentialRef: 'model:test-provider' },
      availability: { status: 'degraded' }
    });
    expect(catalog.getAliases()).toMatchObject({
      'legacy-pro': 'inkpi/creative-pro-v2',
      'writer-pro': 'inkpi/creative-pro-v2'
    });
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
