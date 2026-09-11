import {
  type ContextPipeline,
  RuntimeCacheCoordinator,
  type RuntimeCacheCoordinatorPort,
  type TaskRouter
} from '@inkpi/agent-core';
import type { JitContextProvider } from './jit-context-provider.js';
import type { ProviderResponseCache } from './provider-response-cache.js';
import type { RuntimeCachePersistenceSnapshot } from './runtime-cache-persistence.js';

export interface DaemonRuntimeCachePersistenceTargets {
  coordinator: RuntimeCacheCoordinator;
  context: ContextPipeline;
  retrieval: JitContextProvider;
  provider: ProviderResponseCache;
}

/** Optional lifecycle adapter for the Daemon-owned three-layer cache. */
export interface RuntimeCachePersistence {
  restore(targets: DaemonRuntimeCachePersistenceTargets): boolean | Promise<boolean> | RuntimeCachePersistenceSnapshot;
  save(targets: DaemonRuntimeCachePersistenceTargets): void | Promise<void> | RuntimeCachePersistenceSnapshot;
}

export function resolveDaemonCachePersistenceTargets(
  coordinator: RuntimeCacheCoordinatorPort,
  taskRouter: Pick<TaskRouter, 'contextPipeline' | 'registry'>
): DaemonRuntimeCachePersistenceTargets {
  if (!(coordinator instanceof RuntimeCacheCoordinator)) {
    throw new Error('Daemon cache persistence requires a snapshot-capable cache coordinator');
  }

  const retrieval = taskRouter.contextPipeline
    .list()
    .find((provider): provider is JitContextProvider => provider.id === 'retrieval.jit' && hasSnapshotApi(provider));
  if (!retrieval) {
    throw new Error('Daemon cache persistence requires the retrieval.jit cache provider');
  }

  const providerHandler = taskRouter.registry.list().find((handler) => handler.id === 'runtime.model');
  const provider = providerHandler && getProviderResponseCache(providerHandler);
  if (!provider) {
    throw new Error('Daemon cache persistence requires a runtime.model provider response cache');
  }

  return { coordinator, context: taskRouter.contextPipeline, retrieval, provider };
}

type SnapshotApi = {
  snapshot(): object;
  restore(snapshot: unknown): void;
};

function hasSnapshotApi(value: unknown): value is SnapshotApi {
  return isRecord(value) && typeof value.snapshot === 'function' && typeof value.restore === 'function';
}

function getProviderResponseCache(handler: unknown): ProviderResponseCache | undefined {
  if (!isRecord(handler) || typeof handler.getProviderResponseCache !== 'function') return undefined;
  const cache = handler.getProviderResponseCache();
  return hasSnapshotApi(cache) ? (cache as ProviderResponseCache) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
