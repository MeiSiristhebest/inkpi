import { ContextPipeline } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { JitContextProvider } from '@inkpi/server';
import { FtsSearchEngine, InkDb, InkRepository, JitMemoryRetriever } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

function makeTask(revision: number, id = 'context-cache-task'): AiTask {
  return {
    id,
    kind: 'narrative.continuity',
    input: {
      documentId: 'context-current',
      selection: { documentId: 'context-current', from: 0, to: 0, revision },
      text: 'The ancient beacon hums again.',
      payload: {
        workspaceId: 'context-cache-workspace',
        activeReferences: ['beacon']
      }
    },
    contextPolicy: {
      providerIds: ['retrieval.jit'],
      maxTokens: 4096
    },
    outputContract: { format: 'text' }
  };
}

describe('ContextPipeline cache and JIT retrieval integration', () => {
  it('compiles the real JIT provider, caches the packet, and invalidates by revision', async () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const fts = new FtsSearchEngine(db);
    const now = 1_700_000_000_000;

    repo.createWorkspace({
      id: 'context-cache-workspace',
      title: 'Context Cache Workspace',
      owner: 'test',
      category: 'general',
      targetSize: 100_000,
      createdAt: now,
      updatedAt: now
    });
    repo.createFolder({
      id: 'context-folder',
      workspaceId: 'context-cache-workspace',
      title: 'Chapters',
      orderIndex: 1,
      createdAt: now,
      updatedAt: now
    });
    repo.createDocument({
      id: 'context-previous',
      folderId: 'context-folder',
      workspaceId: 'context-cache-workspace',
      title: 'Chapter One',
      orderIndex: 1,
      synopsis: 'The crew recovered the ancient beacon.',
      contentSize: 80,
      status: 'completed',
      createdAt: now,
      updatedAt: now
    });
    repo.upsertSnapshot({
      documentId: 'context-previous',
      version: 1,
      contentJson: '{}',
      contentMarkdown: 'The ancient beacon was hidden beneath the observatory.',
      contentSize: 60,
      updatedAt: now
    });
    repo.createDocument({
      id: 'context-current',
      folderId: 'context-folder',
      workspaceId: 'context-cache-workspace',
      title: 'Chapter Two',
      orderIndex: 2,
      contentSize: 0,
      status: 'draft',
      createdAt: now,
      updatedAt: now
    });
    fts.rebuildIndex();

    const search = vi.spyOn(fts, 'search');
    try {
      const retriever = new JitMemoryRetriever({ repository: repo, ftsEngine: fts });
      const pipeline = new ContextPipeline();
      const provider = new JitContextProvider(retriever);
      pipeline.register(provider);

      const first = await pipeline.build(makeTask(1));
      const firstJit = first.fragments.find((fragment) => fragment.source === 'retrieval.jit');
      expect(first.projectRevision).toBe(1);
      expect(first.text).toContain('The crew recovered the ancient beacon.');
      expect(firstJit?.data).toMatchObject({
        recentSummaries: [{ documentId: 'context-previous', title: 'Chapter One' }],
        fullTextMatches: [{ documentId: 'context-previous', title: 'Chapter One' }]
      });

      const firstMatches = (firstJit?.data as { fullTextMatches: unknown[] }).fullTextMatches;
      firstMatches.length = 0;

      const cached = await pipeline.build(makeTask(1));
      expect(search).toHaveBeenCalledTimes(1);
      expect(cached).not.toBe(first);
      expect(cached.fingerprint).toBe(first.fingerprint);
      expect(
        (
          cached.fragments.find((fragment) => fragment.source === 'retrieval.jit')?.data as {
            fullTextMatches: unknown[];
          }
        ).fullTextMatches.length
      ).toBe(1);

      const equivalent = await pipeline.build(makeTask(1, 'context-cache-task-new-id'));
      expect(search).toHaveBeenCalledTimes(1);
      expect(equivalent.fingerprint).toBe(cached.fingerprint);

      const revised = await pipeline.build(makeTask(2));
      expect(search).toHaveBeenCalledTimes(2);
      expect(revised.projectRevision).toBe(2);
      expect(revised.fingerprint).not.toBe(cached.fingerprint);

      pipeline.clearCache();
      const retrievalCached = await pipeline.build(makeTask(1, 'retrieval-cache-task-new-id'));
      expect(search).toHaveBeenCalledTimes(2);
      expect(retrievalCached.fingerprint).toBe(cached.fingerprint);
      expect(retrievalCached.fragments.find((fragment) => fragment.source === 'retrieval.jit')?.metadata).toMatchObject(
        { cacheLayer: 'retrieval', cacheHit: true }
      );
      expect(provider.cacheStats()).toMatchObject({ hits: 1, misses: 2 });
      expect(pipeline.cacheStats()).toMatchObject({ hits: 2, misses: 3, invalidations: 2 });
    } finally {
      search.mockRestore();
      db.close();
    }
  });
});
