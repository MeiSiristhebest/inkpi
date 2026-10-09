import {
  type ModelCatalogEntry,
  ModelCatalogManager,
  findModelInCatalog,
  getDeclaredProviderCapabilityMatrix,
  modelCatalogEntryToCapabilityDeclaration
} from '@inkpi/ai';
import { describe, expect, it } from 'vitest';

function entry(
  partial: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, 'id' | 'supportsThinking'>
): ModelCatalogEntry {
  return {
    name: partial.id,
    provider: 'test',
    contextWindow: 1,
    maxTokens: 1,
    supportsTools: false,
    cost: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
    ...partial
  };
}

describe('@inkpi/ai catalog routing (C2)', () => {
  it('resolves canonical aliases explicitly (deepseek-reasoner -> deepseek-r1)', () => {
    const found = findModelInCatalog('deepseek-reasoner');
    expect(found?.id).toBe('deepseek/deepseek-r1');
    const foundQualified = findModelInCatalog('deepseek/deepseek-reasoner');
    expect(foundQualified?.id).toBe('deepseek/deepseek-r1');
  });

  it('prefers exact model IDs over an earlier qualified suffix match', () => {
    expect(findModelInCatalog('deepseek-chat')?.id).toBe('deepseek-chat');
  });

  it('planning route yields a thinking model; drafting yields a non-thinking model', () => {
    const mgr = new ModelCatalogManager();
    const planning = mgr.routeModelForTask('planning');
    const drafting = mgr.routeModelForTask('drafting');
    expect(planning.supportsThinking).toBe(true);
    expect(drafting.supportsThinking).toBe(false);
  });

  it('explicit ROLE_PREFERENCES order wins over catalog order (no substring guessing)', () => {
    const mgr = new ModelCatalogManager([
      entry({ id: 'anthropic/claude-3.7-sonnet', supportsThinking: true }),
      entry({ id: 'deepseek/deepseek-r1', supportsThinking: true })
    ]);
    // deepseek-r1 is listed before claude-3.7-sonnet in ROLE_PREFERENCES.planning.
    expect(mgr.routeModelForTask('planning').id).toBe('deepseek/deepseek-r1');
  });

  it('a model whose id contains "mini" but supports thinking is NOT routed to drafting', () => {
    const mgr = new ModelCatalogManager([
      entry({ id: 'thinking-mini', supportsThinking: true }),
      entry({ id: 'plain-drafter', supportsThinking: false })
    ]);
    expect(mgr.routeModelForTask('drafting').id).toBe('plain-drafter');
  });

  it('filters on the canonical declaration and rejects unsupported named capabilities', () => {
    const mgr = new ModelCatalogManager([
      entry({
        id: 'structured-vision',
        supportsThinking: true,
        supportsTools: true,
        supportsVision: true,
        capabilities: {
          capabilities: ['creative-writing'],
          network: 'optional',
          outputFormats: ['text', 'structured'],
          structuredOutput: true,
          jsonSchema: true,
          promptCaching: true
        }
      }),
      entry({ id: 'text-only', supportsThinking: false })
    ]);

    expect(
      mgr
        .filterByCapability({
          capabilities: ['creative-writing'],
          modalities: ['image'],
          outputFormats: ['structured'],
          reasoning: true,
          jsonSchema: true
        })
        .map((model) => model.id)
    ).toEqual(['structured-vision']);
    expect(mgr.filterByCapability({ capabilities: ['not-declared'] })).toEqual([]);
    expect(mgr.filterByCapability({ vision: false }).map((model) => model.id)).toEqual(['text-only']);
  });

  it('uses priority first and model id as a deterministic tie-break', () => {
    const mgr = new ModelCatalogManager([
      entry({ id: 'zeta-model', supportsThinking: true, priority: 4 }),
      entry({ id: 'alpha-model', supportsThinking: true, priority: 4 }),
      entry({ id: 'priority-model', supportsThinking: true, priority: 5 })
    ]);

    expect(mgr.rankByCapability({ thinking: true }).map((model) => model.id)).toEqual([
      'priority-model',
      'alpha-model',
      'zeta-model'
    ]);
    expect(mgr.getRecommendedPlanningModel().id).toBe('priority-model');
  });

  it('falls back from an incompatible override only to a capability-compatible model', () => {
    const mgr = new ModelCatalogManager([
      entry({ id: 'preferred-thinking', supportsThinking: true, priority: 99 }),
      entry({ id: 'safe-fallback', supportsThinking: false, priority: 1 })
    ]);

    expect(mgr.routeModelForTask('drafting', 'preferred-thinking', { reasoning: false }).id).toBe('safe-fallback');
    expect(() => mgr.routeModelForTask('drafting', 'missing-model', { capabilities: ['not-declared'] })).toThrow(
      /No catalog model satisfies the capability requirements/
    );
  });

  it('rejects invalid declarations before registration and refresh mutation', async () => {
    const invalid: ModelCatalogEntry = entry({
      id: 'invalid-declaration',
      supportsThinking: false,
      capabilities: { structuredOutput: false, jsonSchema: true }
    });

    expect(() => modelCatalogEntryToCapabilityDeclaration(invalid)).toThrow(
      /jsonSchema support requires structuredOutput/
    );
    expect(() => new ModelCatalogManager([invalid])).toThrow(/jsonSchema support requires structuredOutput/);

    const mgr = new ModelCatalogManager([entry({ id: 'existing', supportsThinking: false })]);
    await expect(mgr.refreshCatalog(async () => [invalid])).rejects.toThrow(
      /jsonSchema support requires structuredOutput/
    );
    expect(mgr.getModel('existing')?.id).toBe('existing');
    expect(mgr.getModel('invalid-declaration')).toBeUndefined();
  });

  it('keeps unknown generated prices unavailable without accepting arbitrary negative rates', () => {
    const manager = new ModelCatalogManager([
      entry({
        id: 'unpriced-generated-model',
        supportsThinking: false,
        cost: { inputPerMillionUsd: -1_000_000, outputPerMillionUsd: -1_000_000 }
      })
    ]);

    expect(manager.getModel('unpriced-generated-model')).toBeDefined();
    expect(
      () =>
        new ModelCatalogManager([
          entry({
            id: 'invalid-negative-price',
            supportsThinking: false,
            cost: { inputPerMillionUsd: -1, outputPerMillionUsd: 1 }
          })
        ])
    ).toThrow(/must be a non-negative number/);
  });

  it('supports authoritative catalog replacement without resurrecting removed static entries', async () => {
    const mgr = new ModelCatalogManager([entry({ id: 'tenant/old', supportsThinking: false })]);

    await mgr.refreshCatalog(async () => [entry({ id: 'tenant/current', supportsThinking: false })], {
      mode: 'replace'
    });

    expect(mgr.getModel('tenant/old')).toBeUndefined();
    expect(mgr.getModel('deepseek/deepseek-r1')).toBeUndefined();
    expect(mgr.getAllModels().map((model) => model.id)).toEqual(['tenant/current', 'current']);
  });

  it('does not let an older in-flight refresh overwrite a newer catalog', async () => {
    const mgr = new ModelCatalogManager([entry({ id: 'initial', supportsThinking: false })]);
    let resolveOld!: (models: ModelCatalogEntry[]) => void;
    let resolveNew!: (models: ModelCatalogEntry[]) => void;
    const oldResult = new Promise<ModelCatalogEntry[]>((resolve) => {
      resolveOld = resolve;
    });
    const newResult = new Promise<ModelCatalogEntry[]>((resolve) => {
      resolveNew = resolve;
    });

    const oldRefresh = mgr.refreshCatalog(() => oldResult, { mode: 'replace' });
    const newRefresh = mgr.refreshCatalog(() => newResult, { mode: 'replace' });
    resolveNew([entry({ id: 'newer', supportsThinking: false })]);
    await newRefresh;
    resolveOld([entry({ id: 'older', supportsThinking: false })]);
    await oldRefresh;

    expect(mgr.getAllModels().map((model) => model.id)).toEqual(['newer']);
  });

  it('does not restore a statically known model after explicit unregister', () => {
    const mgr = new ModelCatalogManager([entry({ id: 'deepseek/deepseek-r1', supportsThinking: true })]);

    expect(mgr.unregisterModel('deepseek/deepseek-r1')).toBe(true);
    expect(mgr.getModel('deepseek/deepseek-r1')).toBeUndefined();
    expect(mgr.getModel('deepseek-r1')).toBeUndefined();
  });

  it('sorts a declaration-only provider matrix without claiming provider reachability', () => {
    const matrix = getDeclaredProviderCapabilityMatrix([
      entry({ id: 'z-model', provider: 'z-provider', supportsThinking: false }),
      entry({ id: 'a-model', provider: 'a-provider', supportsThinking: true })
    ]);

    expect(matrix.map((model) => [model.provider, model.modelId])).toEqual([
      ['a-provider', 'a-model'],
      ['z-provider', 'z-model']
    ]);
    expect(matrix[0].declaration.reasoning).toBe(true);
  });
});
