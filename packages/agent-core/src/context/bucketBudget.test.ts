import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { CONTEXT_BUCKET_SHARES, ContextPipeline } from './pipeline.js';

/**
 * The packet used to be one greedy fill: the first fragment that did not fit ended the loop, so an
 * oversized manuscript squeezed every canonical fact and every retrieval hit out of the prompt.
 * Each bucket now gets a floor of its own, and whatever the floors do not spend is reclaimed.
 */

function prose(chars: number): string {
  // One token is four characters in the pipeline's estimate, so a length of n*4 is n tokens.
  return '寒'.repeat(chars);
}

function task(maxTokens: number): AiTask {
  return {
    id: `bucket-${maxTokens}`,
    kind: 'test.bucket',
    input: { documentId: 'chapter-1' },
    contextPolicy: { maxTokens },
    outputContract: { format: 'text' }
  };
}

describe('context bucket budget', () => {
  it('keeps canonical facts and retrieval when the manuscript overflows its share', async () => {
    const pipeline = new ContextPipeline({ maxTokens: 200 });
    pipeline.register({
      id: 'creative.document',
      bucket: 'scene',
      provide: () => [{ id: 'scene-1', source: 'creative.document', text: prose(1200), priority: 800 }]
    });
    pipeline.register({
      id: 'creative.story',
      bucket: 'project',
      provide: () => [
        { id: 'fact-1', source: 'creative.story', text: prose(120), priority: 700 },
        { id: 'fact-2', source: 'creative.story', text: prose(120), priority: 690 }
      ]
    });
    pipeline.register({
      id: 'retrieval.jit',
      bucket: 'retrieval',
      provide: () => [{ id: 'lore-1', source: 'retrieval.jit', text: prose(80), priority: 500 }]
    });
    pipeline.register({
      id: 'creative.conversation-history',
      bucket: 'working',
      provide: () => [{ id: 'turn-1', source: 'creative.conversation-history', text: prose(40), priority: 100 }]
    });

    const packet = await pipeline.build(task(200));

    expect(packet.fragments.map((fragment) => fragment.id).sort()).toEqual([
      'fact-1',
      'fact-2',
      'lore-1',
      'scene-1',
      'turn-1'
    ]);
    expect(packet.tokenEstimate).toBeLessThanOrEqual(200);
    expect(packet.tokenEstimate).toBe(200);
    // The scene kept its floor and nothing more: 200 - (25 project + 15 retrieval + 10 working).
    expect((packet.fragments.find((f) => f.id === 'scene-1')?.text ?? '').length).toBeLessThan(1200);
    expect(packet.truncated).toBe(true);
    expect(packet.fragments.find((f) => f.id === 'scene-1')?.bucket).toBe('scene');
  });

  it('keeps the highest-ranked fragment whole when the budget holds only one', async () => {
    const pipeline = new ContextPipeline({ maxTokens: 4 });
    pipeline.register({
      id: 'creative.document',
      bucket: 'scene',
      provide: () => [
        { id: 'selection', source: 'creative.document', text: prose(14), priority: 900 },
        { id: 'chapter', source: 'creative.document', text: prose(24), priority: 800 }
      ]
    });

    const packet = await pipeline.build(task(4));

    // Clipping is the last pass: splitting the reservation down the middle would spend the budget on
    // a clip of the selection plus the leading characters of a chapter that means nothing alone.
    expect(packet.fragments.map((fragment) => fragment.id)).toEqual(['selection']);
    expect(packet.fragments[0]?.text).toBe(prose(14));
    expect(packet.tokenEstimate).toBe(4);
    expect(packet.truncated).toBe(true);
  });

  it('does not let an untrimmable document structure end the fill', async () => {
    const pipeline = new ContextPipeline({ maxTokens: 100 });
    pipeline.register({
      id: 'creative.document',
      bucket: 'scene',
      provide: () => [{ id: 'structure', source: 'creative.document', data: { blocks: prose(1200) }, priority: 800 }]
    });
    pipeline.register({
      id: 'creative.story',
      bucket: 'project',
      provide: () => [{ id: 'fact-1', source: 'creative.story', text: prose(80), priority: 700 }]
    });
    pipeline.register({
      id: 'retrieval.jit',
      bucket: 'retrieval',
      provide: () => [{ id: 'lore-1', source: 'retrieval.jit', text: prose(80), priority: 500 }]
    });

    const packet = await pipeline.build(task(100));

    // Before the buckets this packet was empty: the structure is a data fragment, so trimming could
    // not shrink it and the fill stopped at it.
    expect(packet.fragments.map((fragment) => fragment.id)).toEqual(['fact-1', 'lore-1']);
    expect(packet.tokenEstimate).toBe(40);
    expect(packet.truncated).toBe(true);
  });

  it('returns an unused reservation to the fragment that left it dark', async () => {
    const pipeline = new ContextPipeline({ maxTokens: 100 });
    pipeline.register({
      id: 'creative.document',
      bucket: 'scene',
      provide: () => [{ id: 'scene-1', source: 'creative.document', text: prose(8), priority: 900 }]
    });
    pipeline.register({
      id: 'unclassified',
      provide: () => [{ id: 'other-1', source: 'unclassified', text: prose(2000), priority: 800 }]
    });

    const packet = await pipeline.build(task(100));

    expect(packet.tokenEstimate).toBe(100);
    expect(packet.fragments.map((fragment) => fragment.id).sort()).toEqual(['other-1', 'scene-1']);
    expect(CONTEXT_BUCKET_SHARES.scene).toBeGreaterThan(0);
  });
});
