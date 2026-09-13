import type { ContextRequest } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import {
  SERIALIZED_CREATIVE_DOCUMENT_PROVIDER_ID,
  SERIALIZED_CREATIVE_STORY_PROVIDER_ID,
  createSerializedCreativeContextProviders
} from './serialized-creative-context-provider.js';

const validContext = {
  documentId: 'chapter-1',
  revision: 7,
  text: '正文',
  selectionText: '当前段落',
  blocks: [{ id: 'block-1', type: 'paragraph', text: '正文', from: 0, to: 2 }],
  neighboringDocuments: [{ documentId: 'chapter-0', revision: 6, text: '前章' }],
  storyContext: { revision: 3, canonicalFacts: [] },
  projectRevision: 7,
  fingerprint: 'context-v1'
};

function request(context: unknown, includeProjectState = true): ContextRequest {
  return {
    task: {
      id: 'serialized-context-test',
      kind: 'creative.continue',
      input: { documentId: 'chapter-1', text: '正文', payload: { context } },
      contextPolicy: { includeProjectState }
    } as AiTask
  };
}

describe('serialized CreativeContext schema boundary', () => {
  it('accepts the complete Desktop context and projects both providers', async () => {
    const [documentProvider, storyProvider] = createSerializedCreativeContextProviders();

    expect(await documentProvider.supports?.(request(validContext))).toBe(true);
    expect(await storyProvider.supports?.(request(validContext))).toBe(true);
    expect(await documentProvider.provide(request(validContext))).toMatchObject([
      {
        source: SERIALIZED_CREATIVE_DOCUMENT_PROVIDER_ID,
        data: expect.objectContaining({ documentId: 'chapter-1', text: '正文' })
      }
    ]);
    expect(await storyProvider.provide(request(validContext))).toMatchObject([
      {
        source: SERIALIZED_CREATIVE_STORY_PROVIDER_ID,
        data: { revision: 3, canonicalFacts: [] }
      }
    ]);
  });

  it.each([
    null,
    {},
    { ...validContext, revision: -1 },
    { ...validContext, blocks: [{ ...validContext.blocks[0], to: -1 }] },
    { ...validContext, neighboringDocuments: [{ documentId: 'chapter-0' }] },
    { ...validContext, storyContext: [] }
  ])('rejects malformed serialized context: %j', async (context) => {
    const [documentProvider, storyProvider] = createSerializedCreativeContextProviders();

    expect(await documentProvider.supports?.(request(context))).toBe(false);
    expect(await storyProvider.supports?.(request(context))).toBe(false);
    expect(await documentProvider.provide(request(context))).toEqual([]);
    expect(await storyProvider.provide(request(context))).toEqual([]);
  });
});
