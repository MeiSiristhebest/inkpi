import { describe, expect, it } from 'vitest';
import { GENERATED_MODELS, KNOWN_MODELS, findModelInCatalog, getModelPreset } from '../packages/ai/src/models.js';

describe('AI models catalog entry', () => {
  it('exposes generated catalog data and presets', () => {
    expect(GENERATED_MODELS.length).toBeGreaterThan(0);
    expect(KNOWN_MODELS.length).toBeGreaterThan(0);
    expect(findModelInCatalog('gpt-4o')?.provider).toBe('openai');
    expect(getModelPreset('creative-fast').provider).toBe('deepseek');
  });
});
