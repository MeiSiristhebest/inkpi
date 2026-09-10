import {
  type CacheInvalidationEvent,
  type RuntimeCacheCoordinatorPort,
  type RuntimeCacheLayerStats,
  sanitizePrivateData,
  shouldInvalidateCacheEntry,
  validateRuntimeCacheLayerStats
} from '@inkpi/agent-core';
import type { AssistantMessage } from '@inkpi/protocol';

const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface ProviderResponseCacheOptions {
  enabled?: boolean;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
  cacheCoordinator?: RuntimeCacheCoordinatorPort;
}

interface ProviderResponseCacheEntry {
  response: AssistantMessage;
  projectRevision?: number;
  expiresAt: number;
}

/** Process-safe snapshot of successful provider responses and their metrics. */
export interface ProviderResponseCacheSnapshot {
  version: 1;
  entries: Array<{
    key: string;
    response: AssistantMessage;
    projectRevision?: number;
    expiresAt: number;
  }>;
  stats: RuntimeCacheLayerStats;
}

/**
 * Bounded in-memory cache for successful final provider responses.
 * Tool-call turns, errors, and invalid output are never inserted by the
 * model handler. The cache stores no database state and no private reasoning
 * telemetry; the Runtime cache coordinator receives only counters.
 */
export class ProviderResponseCache {
  private readonly entries = new Map<string, ProviderResponseCacheEntry>();
  private readonly enabled: boolean;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cacheCoordinator?: RuntimeCacheCoordinatorPort;
  private readonly counters: RuntimeCacheLayerStats = emptyStats();
  private unsubscribe?: () => void;

  constructor(options: ProviderResponseCacheOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.enabled = options.enabled ?? true;
    this.maxEntries = Number.isFinite(maxEntries) ? Math.max(0, Math.floor(maxEntries)) : DEFAULT_MAX_ENTRIES;
    this.ttlMs = Number.isFinite(ttlMs) ? Math.max(0, ttlMs) : DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.cacheCoordinator = options.cacheCoordinator;
    this.unsubscribe = this.cacheCoordinator?.onInvalidate('provider', (event) => this.clear(event));
  }

  get(key: string): AssistantMessage | undefined {
    if (!this.enabled || this.maxEntries === 0) return undefined;
    const entry = this.entries.get(key);
    if (!entry) {
      this.record('miss');
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.record('eviction');
      this.record('miss');
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.record('hit');
    return cloneAssistantMessage(entry.response);
  }

  set(key: string, response: AssistantMessage, projectRevision?: number): void {
    if (!this.enabled || this.maxEntries === 0) return;
    if (!key.trim()) throw new Error('Provider response cache key must not be empty');
    this.entries.delete(key);
    this.entries.set(key, {
      response: cloneAssistantMessage(response),
      projectRevision,
      expiresAt: this.now() + this.ttlMs
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.record('eviction');
    }
  }

  clear(event?: CacheInvalidationEvent): void {
    if (!event) {
      this.counters.invalidations += this.entries.size;
      this.entries.clear();
      return;
    }
    for (const [key, entry] of this.entries) {
      if (!shouldInvalidateCacheEntry(entry.projectRevision, event)) continue;
      this.entries.delete(key);
      this.counters.invalidations += 1;
    }
  }

  stats(): RuntimeCacheLayerStats {
    return { ...this.counters };
  }

  snapshot(): ProviderResponseCacheSnapshot {
    return {
      version: 1,
      entries: [...this.entries].map(([key, entry]) => ({
        key,
        response: cloneAssistantMessage(entry.response),
        projectRevision: entry.projectRevision,
        expiresAt: entry.expiresAt
      })),
      stats: this.stats()
    };
  }

  restore(snapshot: ProviderResponseCacheSnapshot): void {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.entries)) {
      throw new Error('Provider response cache snapshot is unsupported');
    }
    validateRuntimeCacheLayerStats(snapshot.stats);
    const entries = snapshot.entries.map((entry) => validateProviderCacheEntry(entry));
    const duplicateKeys = new Set<string>();
    for (const entry of entries) {
      if (duplicateKeys.has(entry.key)) throw new Error(`Provider response cache snapshot repeats key: ${entry.key}`);
      duplicateKeys.add(entry.key);
    }

    this.entries.clear();
    Object.assign(this.counters, snapshot.stats);
    if (!this.enabled || this.maxEntries === 0) return;

    for (const entry of entries.slice(-this.maxEntries)) {
      this.entries.set(entry.key, {
        response: cloneAssistantMessage(entry.response),
        projectRevision: entry.projectRevision,
        expiresAt: entry.expiresAt
      });
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.entries.clear();
  }

  private record(event: 'hit' | 'miss' | 'eviction'): void {
    switch (event) {
      case 'hit':
        this.counters.hits += 1;
        break;
      case 'miss':
        this.counters.misses += 1;
        break;
      case 'eviction':
        this.counters.evictions += 1;
        break;
    }
    this.cacheCoordinator?.record('provider', event);
  }
}

function emptyStats(): RuntimeCacheLayerStats {
  return { hits: 0, misses: 0, evictions: 0, invalidations: 0 };
}

function cloneAssistantMessage(message: AssistantMessage): AssistantMessage {
  const sanitized = sanitizePrivateData(message);
  const content = sanitized.content
    .filter((item) => item.type !== 'thinking')
    .map((item) =>
      item.type === 'toolCall'
        ? { ...item, arguments: sanitizePrivateData(item.arguments) }
        : item.type === 'text'
          ? { ...item, text: sanitizePrivateData(item.text) }
          : { ...item }
    );
  try {
    return structuredClone({ ...sanitized, content });
  } catch {
    return { ...sanitized, content };
  }
}

function validateProviderCacheEntry(value: unknown): {
  key: string;
  response: AssistantMessage;
  projectRevision?: number;
  expiresAt: number;
} {
  if (!isRecord(value) || typeof value.key !== 'string' || value.key.length === 0) {
    throw new Error('Provider response cache snapshot contains an invalid cache key');
  }
  if (!isRecord(value.response) || value.response.role !== 'assistant' || !Array.isArray(value.response.content)) {
    throw new Error(`Provider response cache snapshot contains an invalid response for key: ${value.key}`);
  }
  if (!isFiniteNumber(value.expiresAt)) {
    throw new Error(`Provider response cache snapshot contains an invalid expiry for key: ${value.key}`);
  }
  if (value.projectRevision !== undefined && !isFiniteNumber(value.projectRevision)) {
    throw new Error(`Provider response cache snapshot contains an invalid revision for key: ${value.key}`);
  }
  return {
    key: value.key,
    response: value.response as unknown as AssistantMessage,
    projectRevision: value.projectRevision as number | undefined,
    expiresAt: value.expiresAt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
