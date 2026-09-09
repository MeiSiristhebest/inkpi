/** Cache layers shared by Runtime cache adapters and future IPC clients. */
export const RUNTIME_CACHE_LAYERS = ['provider', 'context', 'retrieval'] as const;
export type RuntimeCacheLayer = (typeof RUNTIME_CACHE_LAYERS)[number];

export type CacheMetricEvent = 'hit' | 'miss' | 'eviction' | 'invalidation';

export interface RuntimeCacheLayerStats {
  hits: number;
  misses: number;
  evictions: number;
  invalidations: number;
}

export interface RuntimeCacheStats {
  provider: RuntimeCacheLayerStats;
  context: RuntimeCacheLayerStats;
  retrieval: RuntimeCacheLayerStats;
}

export interface CacheInvalidationEvent {
  reason: 'revision' | 'registration' | 'manual';
  projectRevision?: number;
  layers?: readonly RuntimeCacheLayer[];
}

export type CacheInvalidationListener = (event: CacheInvalidationEvent) => void;

/**
 * The minimal bridge between independently hosted cache layers.
 *
 * It carries invalidation and metrics only. It does not own prompt/context
 * data and therefore does not create another provider or Runtime.
 */
export interface RuntimeCacheCoordinatorPort {
  onInvalidate(layer: RuntimeCacheLayer, listener: CacheInvalidationListener): () => void;
  invalidate(event: CacheInvalidationEvent): void;
  record(layer: RuntimeCacheLayer, event: CacheMetricEvent): void;
  stats(): RuntimeCacheStats;
}

export class RuntimeCacheCoordinator implements RuntimeCacheCoordinatorPort {
  private readonly listeners = new Map<RuntimeCacheLayer, Set<CacheInvalidationListener>>();
  private readonly counters = new Map<RuntimeCacheLayer, RuntimeCacheLayerStats>();

  constructor() {
    for (const layer of RUNTIME_CACHE_LAYERS) {
      this.listeners.set(layer, new Set());
      this.counters.set(layer, emptyStats());
    }
  }

  onInvalidate(layer: RuntimeCacheLayer, listener: CacheInvalidationListener): () => void {
    const listeners = this.listeners.get(layer);
    if (!listeners) throw new Error(`Unknown cache layer: ${layer}`);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  invalidate(event: CacheInvalidationEvent): void {
    const layers = event.layers && event.layers.length > 0 ? [...new Set(event.layers)] : RUNTIME_CACHE_LAYERS;
    for (const layer of layers) {
      this.record(layer, 'invalidation');
      for (const listener of this.listeners.get(layer) ?? []) listener(event);
    }
  }

  record(layer: RuntimeCacheLayer, event: CacheMetricEvent): void {
    const stats = this.counters.get(layer);
    if (!stats) throw new Error(`Unknown cache layer: ${layer}`);
    switch (event) {
      case 'hit':
        stats.hits += 1;
        break;
      case 'miss':
        stats.misses += 1;
        break;
      case 'eviction':
        stats.evictions += 1;
        break;
      case 'invalidation':
        stats.invalidations += 1;
        break;
    }
  }

  stats(): RuntimeCacheStats {
    return {
      provider: cloneStats(this.counters.get('provider')!),
      context: cloneStats(this.counters.get('context')!),
      retrieval: cloneStats(this.counters.get('retrieval')!)
    };
  }
}

export interface RuntimeCacheKeyInput {
  layer: RuntimeCacheLayer;
  taskKind?: string;
  instructionVersion?: string;
  skillVersion?: string;
  projectRevision?: number;
  contextFingerprint?: string;
  model?: string;
  provider?: string;
  identity?: unknown;
}

/** Canonical key serializer used by every Runtime cache layer. */
export function createRuntimeCacheKey(input: RuntimeCacheKeyInput): string {
  return stableSerialize({
    contextFingerprint: input.contextFingerprint ?? null,
    identity: input.identity ?? null,
    instructionVersion: input.instructionVersion ?? null,
    layer: input.layer,
    model: input.model ?? null,
    projectRevision: input.projectRevision ?? null,
    provider: input.provider ?? null,
    skillVersion: input.skillVersion ?? null,
    taskKind: input.taskKind ?? null,
    version: 1
  });
}

/** Stable, order-independent serialization for cache identity and fingerprints. */
export function stableSerialize(value: unknown): string {
  return serializeStable(value, new WeakSet<object>());
}

function serializeStable(value: unknown, seen: WeakSet<object>): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (Number.isNaN(value)) return 'number:NaN';
      if (value === Infinity) return 'number:Infinity';
      if (value === -Infinity) return 'number:-Infinity';
      if (Object.is(value, -0)) return 'number:-0';
      return JSON.stringify(value);
    case 'bigint':
      return `bigint:${value.toString()}`;
    case 'function':
      return 'function';
    case 'symbol':
      return `symbol:${String(value)}`;
    default:
      break;
  }

  if (seen.has(value)) throw new TypeError('Cannot serialize a cyclic cache identity');
  seen.add(value);
  try {
    if (value instanceof Date) return `date:${JSON.stringify(value.toISOString())}`;
    if (Array.isArray(value)) return `[${value.map((item) => serializeStable(item, seen)).join(',')}]`;

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeStable(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function emptyStats(): RuntimeCacheLayerStats {
  return { hits: 0, misses: 0, evictions: 0, invalidations: 0 };
}

function cloneStats(stats: RuntimeCacheLayerStats): RuntimeCacheLayerStats {
  return { ...stats };
}
