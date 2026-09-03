import { type ModelCatalogEntry, ModelCatalogManager, findModelInCatalog } from '@inkpi/ai';
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
});
