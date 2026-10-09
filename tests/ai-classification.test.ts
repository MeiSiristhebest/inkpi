import { ModelCatalogV2, classifyText, createFauxProvider } from '@inkpi/ai';
import { describe, expect, it, vi } from 'vitest';

function createCatalog(text: string) {
  const catalog = new ModelCatalogV2([
    {
      id: 'writer/model',
      name: 'Writer model',
      provider: 'classification-test',
      contextWindow: 16_000,
      maxTokens: 512,
      supportsThinking: false,
      supportsTools: false,
      supportsVision: false,
      authentication: { kind: 'none', required: false },
      operations: ['chat', 'image', 'classify']
    }
  ]);
  const handler = vi.fn(createFauxProvider({ text, usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } }));
  catalog.registerHandler('classification-test', handler);
  return { catalog, handler };
}

describe('classifyText', () => {
  it('uses the catalog operation route and returns a validated candidate result', async () => {
    const { catalog, handler } = createCatalog(
      '{"label":"continuity","confidence":0.86,"rationale":"The passage matches prior facts."}'
    );
    const controller = new AbortController();

    const result = await classifyText({
      catalog,
      model: 'writer/model',
      text: 'The chapter conflicts with the earlier age of the character.',
      candidates: [
        { label: 'continuity', description: 'Check against established story facts.' },
        { label: 'tagging', description: 'Suggest a content tag.' }
      ],
      signal: controller.signal
    });

    expect(result).toEqual({
      label: 'continuity',
      confidence: 0.86,
      rationale: 'The passage matches prior facts.',
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      canonicalModelId: 'writer/model'
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ id: 'model', provider: 'classification-test' });
    expect(handler.mock.calls[0]?.[2]).toMatchObject({
      temperature: 0,
      maxTokens: 256,
      signal: controller.signal
    });
  });

  it('rejects operation mismatches before calling a provider', async () => {
    const { catalog, handler } = createCatalog('{"label":"continuity","confidence":0.9}');
    const chatOnly = new ModelCatalogV2([
      {
        id: 'chat-only',
        name: 'Chat only',
        provider: 'classification-test',
        contextWindow: 16_000,
        maxTokens: 512,
        supportsThinking: false,
        supportsTools: false,
        supportsVision: false
      }
    ]);
    chatOnly.registerHandler('classification-test', handler);

    await expect(
      classifyText({ catalog: chatOnly, model: 'chat-only', text: 'text', candidates: [{ label: 'continuity' }] })
    ).rejects.toThrow("does not support the 'classify' operation");
    expect(handler).not.toHaveBeenCalled();
    expect(catalog.getOperations('writer/model')).toEqual(['chat', 'image', 'classify']);
  });

  it.each([
    ['unknown label', '{"label":"other","confidence":0.5}', /unknown candidate/],
    ['out-of-range confidence', '{"label":"continuity","confidence":1.2}', /from 0 to 1/],
    ['malformed JSON', 'not json', /valid JSON/],
    ['extra fields', '{"label":"continuity","confidence":0.5,"debug":true}', /unsupported fields/]
  ])('rejects %s', async (_name, output, expectedError) => {
    const { catalog } = createCatalog(output);
    await expect(
      classifyText({ catalog, model: 'writer/model', text: 'text', candidates: [{ label: 'continuity' }] })
    ).rejects.toThrow(expectedError);
  });

  it('rejects empty and duplicate candidates before starting the provider', async () => {
    const { catalog, handler } = createCatalog('{"label":"continuity","confidence":0.9}');

    await expect(classifyText({ catalog, model: 'writer/model', text: 'text', candidates: [] })).rejects.toThrow(
      'at least one candidate'
    );
    await expect(
      classifyText({
        catalog,
        model: 'writer/model',
        text: 'text',
        candidates: [{ label: 'continuity' }, { label: 'continuity' }]
      })
    ).rejects.toThrow('Duplicate classification candidate');
    expect(handler).not.toHaveBeenCalled();
  });
});
