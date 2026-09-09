import {
  ContextPipeline,
  RuntimeCacheCoordinator,
  TaskObservability,
  TaskRegistry,
  TaskRouter
} from '@inkpi/agent-core';
import { AssistantEventStream } from '@inkpi/ai';
import type { AiTask, ModelConfig } from '@inkpi/protocol';
import { JitContextProvider, TaskModelHandler } from '@inkpi/server';
import type { JitMemoryRetriever } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

const model: ModelConfig = {
  id: 'cross-layer-model',
  name: 'Cross-layer model',
  provider: 'faux'
};

function makeTask(revision: number, id: string): AiTask {
  return {
    id,
    kind: 'cache.cross-layer',
    input: {
      documentId: 'cross-layer-document',
      selection: { documentId: 'cross-layer-document', from: 0, to: 4, revision },
      text: 'The beacon is active.',
      payload: { workspaceId: 'cross-layer-workspace', activeReferences: ['beacon'] }
    },
    contextPolicy: { providerIds: ['retrieval.jit'], maxTokens: 1024 },
    outputContract: { format: 'text' }
  };
}

function emptyLedger() {
  return { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] };
}

describe('Runtime cache statistics across context, retrieval, and provider layers', () => {
  it('reports one task-wide delta and invalidates all populated layers by revision', async () => {
    const coordinator = new RuntimeCacheCoordinator();
    const retriever = {
      retrieve: vi.fn(async () => ({
        l1WorkingMemory: {
          activeLedger: emptyLedger(),
          activeReferences: ['beacon'],
          activeEntities: [],
          activeAssets: []
        },
        l2RecentSummaries: [],
        l3GlobalLore: [],
        assembledPromptBlock: ''
      }))
    } as unknown as JitMemoryRetriever;
    const contextPipeline = new ContextPipeline({ cacheCoordinator: coordinator });
    contextPipeline.register(new JitContextProvider(retriever, { cacheCoordinator: coordinator }));

    let streamCalls = 0;
    const handler = new TaskModelHandler({
      model,
      cacheCoordinator: coordinator,
      stream: () => {
        streamCalls += 1;
        return finalStream('cached answer');
      },
      defaultModelCapabilities: { outputFormats: ['text'], structuredOutput: true }
    });
    const registry = new TaskRegistry();
    registry.register(handler);
    const observer = new TaskObservability({ random: () => 0 });
    const router = new TaskRouter({ registry, contextPipeline, cacheCoordinator: coordinator, observer });

    try {
      router.submit(makeTask(1, 'cross-layer-first'));
      await router.wait('cross-layer-first');
      expect(observer.get('cross-layer-first')).toMatchObject({
        cache: {
          provider: { hits: 0, misses: 1, evictions: 0, invalidations: 0 },
          context: { hits: 0, misses: 1, evictions: 0, invalidations: 0 },
          retrieval: { hits: 0, misses: 1, evictions: 0, invalidations: 0 }
        }
      });

      router.submit(makeTask(1, 'cross-layer-second'));
      await router.wait('cross-layer-second');
      expect(observer.get('cross-layer-second')).toMatchObject({
        cache: {
          provider: { hits: 1, misses: 0, evictions: 0, invalidations: 0 },
          context: { hits: 1, misses: 0, evictions: 0, invalidations: 0 },
          retrieval: { hits: 0, misses: 0, evictions: 0, invalidations: 0 }
        }
      });
      expect(retriever.retrieve).toHaveBeenCalledTimes(1);
      expect(streamCalls).toBe(1);

      coordinator.invalidate({ reason: 'revision', projectRevision: 2 });
      expect(coordinator.stats()).toMatchObject({
        provider: { invalidations: 1 },
        context: { invalidations: 1 },
        retrieval: { invalidations: 1 }
      });

      router.submit(makeTask(2, 'cross-layer-after-invalidation'));
      await router.wait('cross-layer-after-invalidation');
      expect(retriever.retrieve).toHaveBeenCalledTimes(2);
      expect(streamCalls).toBe(2);
      expect(coordinator.stats()).toMatchObject({
        provider: { hits: 1, misses: 2, invalidations: 1 },
        context: { hits: 1, misses: 2, invalidations: 1 },
        retrieval: { hits: 0, misses: 2, invalidations: 1 }
      });
    } finally {
      await router.stop();
    }
  });
});

function finalStream(text: string): AssistantEventStream {
  const result = new AssistantEventStream();
  queueMicrotask(() => {
    result.push({ type: 'text_delta', textDelta: text });
    result.end();
  });
  return result;
}
