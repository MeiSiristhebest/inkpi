import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextPipeline, RuntimeCacheCoordinator, TaskRegistry, TaskRouter } from '@inkpi/agent-core';
import { AssistantEventStream } from '@inkpi/ai';
import type { AiTask, ModelConfig } from '@inkpi/protocol';
import {
  FileRuntimeCachePersistence,
  JitContextProvider,
  ProviderResponseCache,
  TaskModelHandler
} from '@inkpi/server';
import { FtsSearchEngine, InkDb, InkRepository, JitMemoryRetriever } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

const model: ModelConfig = {
  id: 'cache-restart-model',
  name: 'Cache restart model',
  provider: 'faux'
};

const clock = () => 1_700_000_000_000;

describe('Runtime cache persistence across restart', () => {
  it('restores real context, retrieval, and provider calls, then invalidates by revision', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkpi-cache-restart-'));
    const dbPath = join(root, 'state.sqlite');
    const cachePath = join(root, 'cache', 'runtime-cache.json');
    seedRetrievalDatabase(dbPath);

    const first = createRuntime(dbPath, 'first answer');
    const persistence = new FileRuntimeCachePersistence({ filePath: cachePath, now: clock });
    let second: RuntimeInstance | undefined;

    try {
      const firstResult = await run(first.router, makeTask(1, 'before-restart', 1024));
      expect(firstResult).toMatchObject({
        status: 'completed',
        output: { format: 'text', text: 'first answer' },
        provenance: {
          contextSources: expect.arrayContaining(['retrieval.jit']),
          projectRevision: 1,
          providerCacheHit: false
        }
      });
      expect(first.retriever.retrieve).toHaveBeenCalledTimes(1);
      expect(first.stream).toHaveBeenCalledTimes(1);
      expect(first.pipeline.snapshot().entries[0]?.packet.text).toContain('The crew recovered the ancient beacon.');

      const saved = persistence.save({
        coordinator: first.coordinator,
        context: first.pipeline,
        retrieval: first.retrievalProvider,
        provider: first.providerCache
      });
      expect(existsSync(cachePath)).toBe(true);
      expect(saved).toMatchObject({
        version: 1,
        context: { entries: [{ projectRevision: 1 }], stats: { misses: 1 } },
        retrieval: { entries: [{ projectRevision: 1 }], stats: { misses: 1 } },
        provider: { entries: [{ projectRevision: 1 }], stats: { misses: 1 } }
      });

      await closeRuntime(first);

      second = createRuntime(dbPath, 'second answer');
      expect(
        persistence.restore({
          coordinator: second.coordinator,
          context: second.pipeline,
          retrieval: second.retrievalProvider,
          provider: second.providerCache
        })
      ).toBe(true);
      expect(second.pipeline.snapshot().entries[0]?.packet.text).toContain('The crew recovered the ancient beacon.');

      const contextHit = await run(second.router, makeTask(1, 'after-restart-context-hit', 1024));
      expect(contextHit).toMatchObject({
        output: { format: 'text', text: 'first answer' },
        provenance: { providerCacheHit: true, contextSources: expect.arrayContaining(['retrieval.jit']) }
      });
      expect(second.retriever.retrieve).not.toHaveBeenCalled();
      expect(second.stream).not.toHaveBeenCalled();

      // A changed context budget forces a new compilation, while the JIT key
      // remains the same. This proves retrieval restoration independently of
      // the context layer's restored hit.
      const retrievalHit = await run(second.router, makeTask(1, 'after-restart-retrieval-hit', 2048));
      expect(retrievalHit).toMatchObject({
        output: { format: 'text', text: 'first answer' },
        provenance: { providerCacheHit: true, contextSources: expect.arrayContaining(['retrieval.jit']) }
      });
      expect(second.retriever.retrieve).not.toHaveBeenCalled();
      expect(second.stream).not.toHaveBeenCalled();
      expect(second.pipeline.cacheStats()).toMatchObject({ hits: 1, misses: 2 });
      expect(second.retrievalProvider.cacheStats()).toMatchObject({ hits: 1, misses: 1 });
      expect(second.providerCache.stats()).toMatchObject({ hits: 2, misses: 1 });

      second.coordinator.invalidate({ reason: 'revision', projectRevision: 2 });
      expect(second.coordinator.stats()).toMatchObject({
        provider: { invalidations: 1 },
        context: { invalidations: 1 },
        retrieval: { invalidations: 1 }
      });

      const revised = await run(second.router, makeTask(2, 'after-revision', 1024));
      expect(revised).toMatchObject({
        status: 'completed',
        output: { format: 'text', text: 'second answer' },
        provenance: {
          contextSources: expect.arrayContaining(['retrieval.jit']),
          projectRevision: 2,
          providerCacheHit: false
        }
      });
      expect(second.retriever.retrieve).toHaveBeenCalledTimes(1);
      expect(second.stream).toHaveBeenCalledTimes(1);
      expect(second.pipeline.cacheStats()).toMatchObject({ hits: 1, misses: 3, invalidations: 2 });
      expect(second.retrievalProvider.cacheStats()).toMatchObject({
        hits: 1,
        misses: 2,
        invalidations: 1
      });
      expect(second.providerCache.stats()).toMatchObject({ hits: 2, misses: 2, invalidations: 1 });
    } finally {
      await closeRuntime(first);
      if (second) await closeRuntime(second);
    }
  }, 30_000);
});

interface RuntimeInstance {
  closed: boolean;
  db: InkDb;
  coordinator: RuntimeCacheCoordinator;
  pipeline: ContextPipeline;
  retrievalProvider: JitContextProvider;
  providerCache: ProviderResponseCache;
  retriever: JitMemoryRetriever;
  stream: ReturnType<typeof vi.fn>;
  router: TaskRouter;
}

function createRuntime(dbPath: string, answer: string): RuntimeInstance {
  const db = new InkDb(dbPath);
  const repository = new InkRepository(db);
  const fts = new FtsSearchEngine(db);
  const retriever = new JitMemoryRetriever({ repository, ftsEngine: fts });
  const retrievalSpy = vi.spyOn(retriever, 'retrieve');
  const coordinator = new RuntimeCacheCoordinator();
  const pipeline = new ContextPipeline({ cacheCoordinator: coordinator });
  const retrievalProvider = new JitContextProvider(retriever, {
    cacheCoordinator: coordinator,
    cache: { now: clock, ttlMs: 60_000 }
  });
  pipeline.register(retrievalProvider);

  const stream = vi.fn(() => finalStream(answer));
  const providerCache = new ProviderResponseCache({
    cacheCoordinator: coordinator,
    now: clock,
    ttlMs: 60_000
  });
  const handler = new TaskModelHandler({
    model,
    providerResponseCache: providerCache,
    stream,
    defaultModelCapabilities: { outputFormats: ['text'], structuredOutput: true }
  });
  const registry = new TaskRegistry();
  registry.register(handler);
  const router = new TaskRouter({ registry, contextPipeline: pipeline, cacheCoordinator: coordinator });

  return {
    closed: false,
    db,
    coordinator,
    pipeline,
    retrievalProvider,
    providerCache,
    retriever: Object.assign(retriever, { retrieve: retrievalSpy }),
    stream,
    router
  };
}

async function run(router: TaskRouter, task: AiTask) {
  router.submit(task);
  return router.wait(task.id);
}

async function closeRuntime(runtime: RuntimeInstance): Promise<void> {
  if (runtime.closed) return;
  runtime.closed = true;
  await runtime.router.stop();
  runtime.pipeline.dispose();
  runtime.retrievalProvider.dispose();
  runtime.providerCache.dispose();
  runtime.db.close();
}

function makeTask(revision: number, id: string, maxTokens: number): AiTask {
  return {
    id,
    kind: 'cache.restart',
    input: {
      documentId: 'context-current',
      selection: { documentId: 'context-current', from: 0, to: 4, revision },
      text: 'The ancient beacon hums again.',
      payload: { workspaceId: 'cache-restart-workspace', activeReferences: ['beacon'] }
    },
    contextPolicy: { providerIds: ['retrieval.jit'], maxTokens },
    outputContract: { format: 'text' }
  };
}

function seedRetrievalDatabase(dbPath: string): void {
  const db = new InkDb(dbPath);
  const repository = new InkRepository(db);
  const fts = new FtsSearchEngine(db);
  const now = 1_700_000_000_000;

  repository.createWorkspace({
    id: 'cache-restart-workspace',
    title: 'Cache Restart Workspace',
    owner: 'test',
    category: 'general',
    targetSize: 100_000,
    createdAt: now,
    updatedAt: now
  });
  repository.createFolder({
    id: 'cache-restart-folder',
    workspaceId: 'cache-restart-workspace',
    title: 'Chapters',
    orderIndex: 1,
    createdAt: now,
    updatedAt: now
  });
  repository.createDocument({
    id: 'context-previous',
    folderId: 'cache-restart-folder',
    workspaceId: 'cache-restart-workspace',
    title: 'Chapter One',
    orderIndex: 1,
    synopsis: 'The crew recovered the ancient beacon.',
    contentSize: 80,
    status: 'completed',
    createdAt: now,
    updatedAt: now
  });
  repository.upsertSnapshot({
    documentId: 'context-previous',
    version: 1,
    contentJson: '{}',
    contentMarkdown: 'The ancient beacon was hidden beneath the observatory.',
    contentSize: 60,
    updatedAt: now
  });
  repository.createDocument({
    id: 'context-current',
    folderId: 'cache-restart-folder',
    workspaceId: 'cache-restart-workspace',
    title: 'Chapter Two',
    orderIndex: 2,
    contentSize: 0,
    status: 'draft',
    createdAt: now,
    updatedAt: now
  });
  fts.rebuildIndex();
  db.close();
}

function finalStream(text: string): AssistantEventStream {
  const result = new AssistantEventStream();
  queueMicrotask(() => {
    result.push({ type: 'text_delta', textDelta: text });
    result.end();
  });
  return result;
}
