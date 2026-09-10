import { ContextPipeline, RuntimeCacheCoordinator, TaskRegistry, TaskRouter } from '@inkpi/agent-core';
import type { AiTask, AssistantMessage, JitContextResult, ModelConfig } from '@inkpi/protocol';
import { InkPiDaemon, JitContextProvider, type RuntimeCachePersistence, TaskModelHandler } from '@inkpi/server';
import type { JitMemoryRetriever } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

const model: ModelConfig = {
  id: 'daemon-cache-lifecycle-model',
  name: 'Daemon cache lifecycle model',
  provider: 'openai'
};

describe('InkPiDaemon cache persistence lifecycle', () => {
  it('restores before start and saves all three cache layers on stop', async () => {
    const persistence = new InMemoryCachePersistence();
    const first = createDaemon(persistence);
    const firstNetwork = stubNetwork(first);

    try {
      await first.start();
      await seedCaches(first);
      await first.stop();

      expect(persistence.restoreCalls).toBe(1);
      expect(persistence.saveCalls).toBe(1);
      expect(persistence.saved?.context.entries).toHaveLength(1);
      expect(persistence.saved?.retrieval.entries).toHaveLength(1);
      expect(persistence.saved?.provider.entries).toHaveLength(1);
      expect(firstNetwork.listenTcp).toHaveBeenCalledOnce();

      const second = createDaemon(persistence);
      const secondNetwork = stubNetwork(second);
      try {
        await second.start();
        expect(persistence.restoreCalls).toBe(2);
        expect(second.getTaskRouter().contextPipeline.snapshot().entries).toHaveLength(1);
        expect(findRetrievalProvider(second).snapshot().entries).toHaveLength(1);
        expect(findModelHandler(second).getProviderResponseCache().snapshot().entries).toHaveLength(1);
        expect(second.getCacheCoordinator().stats()).toMatchObject({
          context: { misses: 1 },
          retrieval: { misses: 1 },
          provider: { misses: 0 }
        });
      } finally {
        await second.stop();
        expect(secondNetwork.listenTcp).toHaveBeenCalledOnce();
      }
    } finally {
      await first.stop();
    }
  });

  it('fails startup and does not expose a listener when restore rejects a corrupt snapshot', async () => {
    const persistence: RuntimeCachePersistence = {
      restore: () => Promise.reject(new Error('Runtime cache snapshot is not valid JSON')),
      save: () => {
        throw new Error('save should not run');
      }
    };
    const daemon = createDaemon(persistence);
    const network = stubNetwork(daemon);

    await expect(daemon.start()).rejects.toThrow('Runtime cache snapshot is not valid JSON');
    expect(network.listenTcp).not.toHaveBeenCalled();
    await daemon.stop();
  });
});

class InMemoryCachePersistence implements RuntimeCachePersistence {
  saved?: {
    coordinator: ReturnType<RuntimeCacheCoordinator['snapshot']>;
    context: ReturnType<ContextPipeline['snapshot']>;
    retrieval: ReturnType<JitContextProvider['snapshot']>;
    provider: ReturnType<ReturnType<TaskModelHandler['getProviderResponseCache']>['snapshot']>;
  };
  restoreCalls = 0;
  saveCalls = 0;

  restore(targets: Parameters<RuntimeCachePersistence['restore']>[0]): boolean {
    this.restoreCalls += 1;
    if (!this.saved) return false;
    targets.coordinator.restore(this.saved.coordinator);
    targets.context.restore(this.saved.context);
    targets.retrieval.restore(this.saved.retrieval);
    targets.provider.restore(this.saved.provider);
    return true;
  }

  save(targets: Parameters<RuntimeCachePersistence['save']>[0]): void {
    this.saveCalls += 1;
    this.saved = structuredClone({
      coordinator: targets.coordinator.snapshot(),
      context: targets.context.snapshot(),
      retrieval: targets.retrieval.snapshot(),
      provider: targets.provider.snapshot()
    });
  }
}

function createDaemon(cachePersistence: RuntimeCachePersistence): InkPiDaemon {
  const coordinator = new RuntimeCacheCoordinator();
  const pipeline = new ContextPipeline({ cacheCoordinator: coordinator });
  const retriever = {
    retrieve: vi.fn(async () => fakeRetrievalResult())
  } as unknown as JitMemoryRetriever;
  pipeline.register(new JitContextProvider(retriever, { cacheCoordinator: coordinator }));

  const handler = new TaskModelHandler({
    model,
    providerResponseCacheOptions: { now: () => 1_700_000_000_000 },
    stream: () => {
      throw new Error('provider stream should not run in cache lifecycle test');
    },
    defaultModelCapabilities: { outputFormats: ['text'], structuredOutput: true },
    cacheCoordinator: coordinator
  });
  const registry = new TaskRegistry();
  registry.register(handler);
  const router = new TaskRouter({ registry, contextPipeline: pipeline, cacheCoordinator: coordinator });

  return new InkPiDaemon({
    cacheCoordinator: coordinator,
    cachePersistence,
    context: { taskRouter: router }
  });
}

async function seedCaches(daemon: InkPiDaemon): Promise<void> {
  const task: AiTask = {
    id: 'daemon-cache-lifecycle-task',
    kind: 'daemon.cache.lifecycle',
    input: {
      documentId: 'doc-1',
      text: 'The beacon is stable.',
      payload: { workspaceId: 'workspace-1', activeReferences: ['beacon'] }
    },
    contextPolicy: { providerIds: ['retrieval.jit'], maxTokens: 512 },
    outputContract: { format: 'text' }
  };
  await daemon.getTaskRouter().contextPipeline.build(task);
  findModelHandler(daemon)
    .getProviderResponseCache()
    .set(
      'daemon-cache-lifecycle-key',
      { role: 'assistant', content: [{ type: 'text', text: 'cached answer' }] } as AssistantMessage,
      1
    );
}

function findRetrievalProvider(daemon: InkPiDaemon): JitContextProvider {
  const provider = daemon
    .getTaskRouter()
    .contextPipeline.list()
    .find((entry) => entry.id === 'retrieval.jit');
  if (!(provider instanceof JitContextProvider)) throw new Error('retrieval.jit test provider not found');
  return provider;
}

function findModelHandler(daemon: InkPiDaemon): TaskModelHandler {
  const handler = daemon
    .getTaskRouter()
    .registry.list()
    .find((entry) => entry.id === 'runtime.model');
  if (!(handler instanceof TaskModelHandler)) throw new Error('runtime.model test handler not found');
  return handler;
}

function stubNetwork(daemon: InkPiDaemon) {
  const rpcServer = daemon.getRpcServer();
  const listenTcp = vi.spyOn(rpcServer, 'listenTcp').mockResolvedValue({
    address: () => ({ port: 45_678 })
  } as never);
  vi.spyOn(rpcServer, 'close').mockResolvedValue(undefined);
  return { listenTcp };
}

function fakeRetrievalResult(): JitContextResult {
  return {
    l1WorkingMemory: {
      activeLedger: {} as JitContextResult['l1WorkingMemory']['activeLedger'],
      activeReferences: ['beacon'],
      activeEntities: [],
      activeAssets: []
    },
    l2RecentSummaries: [],
    l3GlobalLore: [],
    assembledPromptBlock: 'beacon'
  };
}
