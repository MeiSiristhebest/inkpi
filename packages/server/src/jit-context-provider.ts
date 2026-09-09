import type { ContextFragment, ContextProvider, ContextRequest } from '@inkpi/agent-core';
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
}

export interface JitRetrievalCacheStats {
  hits: number;
  misses: number;
  evictions: number;
}

interface RetrievalCacheEntry {
  result: JitContextResult;
  expiresAt?: number;
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

  constructor(
    private readonly retriever: JitMemoryRetriever,
    options: JitContextProviderOptions = {}
  ) {
    this.cacheEnabled = options.cache?.enabled ?? true;
    this.cacheMaxEntries = Math.max(0, Math.floor(options.cache?.maxEntries ?? 128));
    this.cacheTtlMs = options.cache?.ttlMs;
    this.now = options.cache?.now ?? Date.now;
  }

  cacheStats(): JitRetrievalCacheStats {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      evictions: this.cacheEvictions
    };
  }

  clearCache(): void {
    this.cache.clear();
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
      maxFtsResults: asNumber(values.maxFtsResults),
    };
    const cacheKey = retrievalCacheKey(query, request.projectRevision);
    const cached = this.getCached(cacheKey);
    const cacheHit = cached !== undefined;
    const result = cached ?? (await this.retriever.retrieve(query));
    if (!cacheHit) this.setCached(cacheKey, result);
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
          fullTextMatches: result.l3GlobalLore,
        },
        priority: 500,
        metadata: { cacheLayer: 'retrieval', cacheHit }
      },
    ];
  }

  private getCached(key: string): JitContextResult | undefined {
    if (!this.cacheEnabled || this.cacheMaxEntries === 0) return undefined;
    const entry = this.cache.get(key);
    if (!entry) {
      this.cacheMisses += 1;
      return undefined;
    }
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      this.cacheMisses += 1;
      return undefined;
    }
    this.cacheHits += 1;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return cloneResult(entry.result);
  }

  private setCached(key: string, result: JitContextResult): void {
    if (!this.cacheEnabled || this.cacheMaxEntries === 0) return;
    const now = this.now();
    this.cache.delete(key);
    this.cache.set(key, {
      result: cloneResult(result),
      expiresAt: this.cacheTtlMs === undefined ? undefined : now + Math.max(0, this.cacheTtlMs)
    });
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.cacheEvictions += 1;
    }
  }
}

function retrievalCacheKey(query: JitContextQuery, projectRevision?: number): string {
  return stableSerialize({ projectRevision: projectRevision ?? null, query });
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
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

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
