import { dirname } from 'node:path';
import {
  type ContextPipeline,
  type ContextPipelineSnapshot,
  type FileSystem,
  type RuntimeCacheCoordinator,
  type RuntimeCacheCoordinatorSnapshot,
  nodeFileSystem
} from '@inkpi/agent-core';
import type { JitContextProvider, JitRetrievalCacheSnapshot } from './jit-context-provider.js';
import type { ProviderResponseCache, ProviderResponseCacheSnapshot } from './provider-response-cache.js';

export const RUNTIME_CACHE_PERSISTENCE_VERSION = 1 as const;

export interface RuntimeCachePersistenceSnapshot {
  version: typeof RUNTIME_CACHE_PERSISTENCE_VERSION;
  savedAt: number;
  coordinator: RuntimeCacheCoordinatorSnapshot;
  context: ContextPipelineSnapshot;
  retrieval: JitRetrievalCacheSnapshot;
  provider: ProviderResponseCacheSnapshot;
}

export interface RuntimeCachePersistenceTargets {
  coordinator: RuntimeCacheCoordinator;
  context: ContextPipeline;
  retrieval: JitContextProvider;
  provider: ProviderResponseCache;
}

export interface FileRuntimeCachePersistenceOptions {
  filePath: string;
  fileSystem?: FileSystem;
  now?: () => number;
}

/**
 * Durable JSON adapter for the three Runtime cache layers.
 *
 * Cache entries are process-local by design; this adapter is the explicit
 * boundary used by a composition root that wants to carry them across a
 * restart. The snapshot is versioned and contains metrics as well as data,
 * while each cache retains ownership of its validation and LRU policy.
 */
export class FileRuntimeCachePersistence {
  private readonly fileSystem: FileSystem;
  private readonly now: () => number;
  private readonly filePath: string;

  constructor(options: FileRuntimeCachePersistenceOptions) {
    if (!options.filePath.trim()) throw new Error('Runtime cache persistence path must not be empty');
    this.filePath = options.filePath;
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.now = options.now ?? Date.now;
  }

  save(targets: RuntimeCachePersistenceTargets): RuntimeCachePersistenceSnapshot {
    const snapshot: RuntimeCachePersistenceSnapshot = {
      version: RUNTIME_CACHE_PERSISTENCE_VERSION,
      savedAt: this.now(),
      coordinator: targets.coordinator.snapshot(),
      context: targets.context.snapshot(),
      retrieval: targets.retrieval.snapshot(),
      provider: targets.provider.snapshot()
    };

    let serialized: string;
    try {
      serialized = JSON.stringify(snapshot);
    } catch (error) {
      throw new Error('Runtime cache snapshot could not be serialized', { cause: error });
    }
    this.fileSystem.mkdirSync(dirname(this.filePath), { recursive: true });
    this.fileSystem.writeFileSync(this.filePath, serialized);
    return snapshot;
  }

  load(): RuntimeCachePersistenceSnapshot | undefined {
    if (!this.fileSystem.existsSync(this.filePath)) return undefined;
    const raw = this.fileSystem.readFileSync(this.filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch (error) {
      throw new Error('Runtime cache snapshot is not valid JSON', { cause: error });
    }
    validateSnapshotEnvelope(parsed);
    return parsed;
  }

  restore(targets: RuntimeCachePersistenceTargets): boolean {
    const snapshot = this.load();
    if (!snapshot) return false;
    targets.coordinator.restore(snapshot.coordinator);
    targets.context.restore(snapshot.context);
    targets.retrieval.restore(snapshot.retrieval);
    targets.provider.restore(snapshot.provider);
    return true;
  }
}

function validateSnapshotEnvelope(value: unknown): asserts value is RuntimeCachePersistenceSnapshot {
  if (!isRecord(value) || value.version !== RUNTIME_CACHE_PERSISTENCE_VERSION) {
    throw new Error('Runtime cache snapshot version is unsupported');
  }
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) {
    throw new Error('Runtime cache snapshot has an invalid save time');
  }
  for (const field of ['coordinator', 'context', 'retrieval', 'provider'] as const) {
    if (!isRecord(value[field])) throw new Error(`Runtime cache snapshot is missing ${field} data`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
