import type { ContextFragment, ContextProvider, ContextRequest } from '@inkpi/agent-core';
import {
  type CacheInvalidationEvent,
  type RuntimeCacheCoordinatorPort,
  createRuntimeCacheKey,
  shouldInvalidateCacheEntry,
  stableSerialize,
  validateRuntimeCacheLayerStats
} from '@inkpi/agent-core';
import type { JitContextQuery, JitContextResult } from '@inkpi/protocol';
import type { JitMemoryRetriever } from '@inkpi/storage';

export interface JitRetrievalCacheOptions {
  enabled?: boolean;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

export interface JitContextProviderOptions {
  cache?: JitRetrievalCacheOptions;
  cacheCoordinator?: RuntimeCacheCoordinatorPort;
}

export interface JitRetrievalCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  invalidations: number;
}

/** Process-safe snapshot of JIT retrieval entries and their metrics. */
export interface JitRetrievalCacheSnapshot {
  version: 1;
  entries: Array<{
    key: string;
    result: JitContextResult;
    expiresAt?: number;
    projectRevision?: number;
  }>;
  stats: JitRetrievalCacheStats;
}

interface RetrievalCacheEntry {
  result: JitContextResult;
  expiresAt?: number;
  projectRevision?: number;
}

/** Adapts the existing JIT retriever to the generic context pipeline. */
export class JitContextProvider implements ContextProvider {
  readonly id = 'retrieval.jit';
  private readonly cache = new Map<string, RetrievalCacheEntry>();
  private readonly cacheEnabled: boolean;
  private readonly cacheMaxEntries: number;
  private readonly cacheTtlMs?: number;
  private readonly now: () => number;
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheEvictions = 0;
  private cacheInvalidations = 0;
  private readonly cacheCoordinator?: RuntimeCacheCoordinatorPort;
  private cacheInvalidationUnsubscribe?: () => void;

  constructor(
    private readonly retriever: JitMemoryRetriever,
    options: JitContextProviderOptions = {}
  ) {
    this.cacheEnabled = options.cache?.enabled ?? true;
    this.cacheMaxEntries = Math.max(0, Math.floor(options.cache?.maxEntries ?? 128));
    this.cacheTtlMs = options.cache?.ttlMs;
    this.now = options.cache?.now ?? Date.now;
    this.cacheCoordinator = options.cacheCoordinator;
    this.cacheInvalidationUnsubscribe = this.cacheCoordinator?.onInvalidate('retrieval', (event) =>
      this.clearCache(event)
    );
  }

  cacheStats(): JitRetrievalCacheStats {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      evictions: this.cacheEvictions,
      invalidations: this.cacheInvalidations
    };
  }

  snapshot(): JitRetrievalCacheSnapshot {
    return {
      version: 1,
      entries: [...this.cache].map(([key, entry]) => ({
        key,
        result: cloneResult(entry.result),
        expiresAt: entry.expiresAt,
        projectRevision: entry.projectRevision
      })),
      stats: this.cacheStats()
    };
  }

  restore(snapshot: JitRetrievalCacheSnapshot): void {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.entries)) {
      throw new Error('JIT retrieval cache snapshot is unsupported');
    }
    validateRuntimeCacheLayerStats(snapshot.stats);
    const entries = snapshot.entries.map((entry) => validateRetrievalCacheEntry(entry));
    const duplicateKeys = new Set<string>();
    for (const entry of entries) {
      if (duplicateKeys.has(entry.key)) throw new Error(`JIT retrieval cache snapshot repeats key: ${entry.key}`);
      duplicateKeys.add(entry.key);
    }

    this.cache.clear();
    this.cacheHits = snapshot.stats.hits;
    this.cacheMisses = snapshot.stats.misses;
    this.cacheEvictions = snapshot.stats.evictions;
    this.cacheInvalidations = snapshot.stats.invalidations;
    if (!this.cacheEnabled || this.cacheMaxEntries === 0) return;

    for (const entry of entries.slice(-this.cacheMaxEntries)) {
      this.cache.set(entry.key, {
        result: cloneResult(entry.result),
        expiresAt: entry.expiresAt,
        projectRevision: entry.projectRevision
      });
    }
  }

  clearCache(event?: CacheInvalidationEvent): void {
    if (!event) {
      this.cacheInvalidations += this.cache.size;
      this.cache.clear();
      return;
    }

    for (const [key, entry] of this.cache) {
      if (!shouldInvalidateCacheEntry(entry.projectRevision, event)) continue;
      this.cache.delete(key);
      this.cacheInvalidations += 1;
    }
  }

  /** Stop listening to a shared coordinator when the owning Runtime is disposed. */
  dispose(): void {
    this.cacheInvalidationUnsubscribe?.();
    this.cacheInvalidationUnsubscribe = undefined;
  }

  async provide(request: ContextRequest): Promise<ContextFragment[]> {
    const payload = request.task.input.payload;
    const values = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const metadata = request.metadata ?? {};
    const query: JitContextQuery = {
      workspaceId: firstString(values.workspaceId, metadata.workspaceId),
      currentDocumentId: request.task.input.documentId,
      currentText: request.task.input.text,
      activeReferences: asStringArray(values.activeReferences),
      maxSummaryDocuments: asNumber(values.maxSummaryDocuments),
      maxFtsResults: asNumber(values.maxFtsResults)
    };
    const cacheKey = createRetrievalCacheKey(query, request.projectRevision, request);
    const cached = this.getCached(cacheKey);
    const cacheHit = cached !== undefined;
    const result = cached ?? (await this.retriever.retrieve(query));
    if (!cacheHit) this.setCached(cacheKey, result, request.projectRevision);
    if (
      !result.l2RecentSummaries.length &&
      !result.l3GlobalLore.length &&
      !result.l1WorkingMemory.activeReferences.length
    ) {
      return [];
    }
    return [
      {
        id: `jit:${hash(cacheKey)}`,
        source: this.id,
        kind: 'retrieval-result',
        data: {
          workingMemory: result.l1WorkingMemory,
          recentSummaries: result.l2RecentSummaries,
          fullTextMatches: result.l3GlobalLore
        },
        priority: 500,
        metadata: { cacheLayer: 'retrieval', cacheHit }
      }
    ];
  }

  private getCached(key: string): JitContextResult | undefined {
    if (!this.cacheEnabled || this.cacheMaxEntries === 0) return undefined;
    const entry = this.cache.get(key);
    if (!entry) {
      this.cacheMisses += 1;
      this.cacheCoordinator?.record('retrieval', 'miss');
      return undefined;
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      this.cacheMisses += 1;
      this.cacheCoordinator?.record('retrieval', 'miss');
      return undefined;
    }
    this.cacheHits += 1;
    this.cacheCoordinator?.record('retrieval', 'hit');
    this.cache.delete(key);
    this.cache.set(key, entry);
    return cloneResult(entry.result);
  }

  private setCached(key: string, result: JitContextResult, projectRevision?: number): void {
    if (!this.cacheEnabled || this.cacheMaxEntries === 0) return;
    const now = this.now();
    this.cache.delete(key);
    this.cache.set(key, {
      result: cloneResult(result),
      expiresAt: this.cacheTtlMs === undefined ? undefined : now + Math.max(0, this.cacheTtlMs),
      projectRevision
    });
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.cacheEvictions += 1;
      this.cacheCoordinator?.record('retrieval', 'eviction');
    }
  }
}

export function createRetrievalCacheKey(
  query: JitContextQuery,
  projectRevision?: number,
  request?: Pick<ContextRequest, 'purpose' | 'metadata'>
): string {
  const metadata = request?.metadata ?? {};
  return createRuntimeCacheKey({
    layer: 'retrieval',
    taskKind: request?.purpose,
    instructionVersion: firstString(metadata.instructionVersion),
    skillVersion: firstString(metadata.skillVersion),
    projectRevision,
    contextFingerprint: firstString(metadata.contextFingerprint),
    model: firstString(metadata.model, metadata.modelId),
    provider: 'retrieval.jit',
    identity: { queryFingerprint: hash(stableSerialize(query)) }
  });
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function cloneResult(result: JitContextResult): JitContextResult {
  try {
    return structuredClone(result);
  } catch {
    return JSON.parse(JSON.stringify(result)) as JitContextResult;
  }
}

function validateRetrievalCacheEntry(value: unknown): {
  key: string;
  result: JitContextResult;
  expiresAt?: number;
  projectRevision?: number;
} {
  if (!isRecord(value) || typeof value.key !== 'string' || value.key.length === 0) {
    throw new Error('JIT retrieval cache snapshot contains an invalid cache key');
  }
  if (
    !isRecord(value.result) ||
    !isRecord(value.result.l1WorkingMemory) ||
    !Array.isArray(value.result.l2RecentSummaries) ||
    !Array.isArray(value.result.l3GlobalLore) ||
    typeof value.result.assembledPromptBlock !== 'string'
  ) {
    throw new Error(`JIT retrieval cache snapshot contains an invalid result for key: ${value.key}`);
  }
  if (value.expiresAt !== undefined && !isFiniteNumber(value.expiresAt)) {
    throw new Error(`JIT retrieval cache snapshot contains an invalid expiry for key: ${value.key}`);
  }
  if (value.projectRevision !== undefined && !isFiniteNumber(value.projectRevision)) {
    throw new Error(`JIT retrieval cache snapshot contains an invalid revision for key: ${value.key}`);
  }
  return {
    key: value.key,
    result: value.result as unknown as JitContextResult,
    expiresAt: value.expiresAt as number | undefined,
    projectRevision: value.projectRevision as number | undefined
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
