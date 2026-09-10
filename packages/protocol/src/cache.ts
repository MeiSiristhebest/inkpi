/** Public cache lifecycle contracts shared by Desktop and the Daemon. */

export const CACHE_LAYERS = ['provider', 'context', 'retrieval'] as const;
export type CacheLayer = (typeof CACHE_LAYERS)[number];

export interface CacheLayerStats {
  hits: number;
  misses: number;
  evictions: number;
  invalidations: number;
}

export interface CacheStats {
  provider: CacheLayerStats;
  context: CacheLayerStats;
  retrieval: CacheLayerStats;
}

export interface CacheStatus {
  version: 1;
  stats: CacheStats;
}

export interface CacheInvalidateParams {
  reason: 'revision' | 'manual';
  projectRevision?: number;
  layers?: CacheLayer[];
}

export interface CacheInvalidateResult {
  accepted: true;
  status: CacheStatus;
}
