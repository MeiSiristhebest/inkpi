import { modelCatalogEntryToCapabilityDeclaration } from './catalog.js';
import type { ModelCatalogEntry, ModelPriceDescriptor, ModelPriceRateOverrides } from './catalog.js';
import { getHttpClient } from './http-client.js';

export interface RemoteCatalogOptions {
  /** Remote model and price directory. */
  url?: string;
  /** Local cache TTL in milliseconds. Defaults to one hour. */
  cacheTtlMs?: number;
  /** Merge supplemental entries by default, or replace this URL's prior directory. */
  mode?: 'merge' | 'replace';
  signal?: AbortSignal;
}

export interface CostCalculationResult {
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  cacheReadCostUsd: number | null;
  cacheWriteCostUsd: number | null;
  totalCostUsd: number | null;
  savedCostByCacheUsd: number | null;
  status: 'known' | 'partial' | 'unknown';
}

export interface ModelCostUsage {
  inputTokens: number;
  outputTokens: number;
  promptTokens?: number;
  serviceTier?: string;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

interface RemoteCatalogState {
  entries: Map<string, ModelCatalogEntry>;
  etag?: string;
  lastFetchedAt: number;
  generation: number;
}

const registeredCatalog = new Map<string, ModelCatalogEntry>();
const remoteCatalogs = new Map<string, RemoteCatalogState>();
const DEFAULT_TTL = 3600_000;

/** Register a local or explicitly configured model price. */
export function registerModelCost(entry: ModelCatalogEntry): void {
  modelCatalogEntryToCapabilityDeclaration(entry);
  registeredCatalog.set(entry.id, entry);
}

/**
 * Refresh one remote directory. Conditional requests are scoped by URL, and a
 * response only publishes if it is still the newest request for that URL.
 */
export async function refreshCatalog(options?: RemoteCatalogOptions): Promise<number> {
  const url = options?.url || process.env.INKPI_MODELS_CATALOG_URL;
  if (!url) return getCatalogSize();

  const ttl = options?.cacheTtlMs ?? DEFAULT_TTL;
  if (!Number.isFinite(ttl) || ttl < 0) throw new RangeError('Model catalog cache TTL must be non-negative.');

  let state = remoteCatalogs.get(url);
  if (!state) {
    state = { entries: new Map(), lastFetchedAt: 0, generation: 0 };
    remoteCatalogs.set(url, state);
  }

  const now = Date.now();
  if (state.lastFetchedAt > 0 && now - state.lastFetchedAt < ttl) return getCatalogSize();

  const generation = ++state.generation;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (state.etag) headers['If-None-Match'] = state.etag;

  try {
    const response = await getHttpClient().fetch(url, {
      method: 'GET',
      headers,
      signal: options?.signal
    });

    if (response.status === 304) {
      if (remoteCatalogs.get(url) !== state || generation !== state.generation) return getCatalogSize();
      state.etag = response.headers.get('etag') ?? state.etag;
      state.lastFetchedAt = Date.now();
      return getCatalogSize();
    }
    if (!response.ok) return getCatalogSize();

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return getCatalogSize();

    const fetched = new Map<string, ModelCatalogEntry>();
    for (const candidate of payload) {
      if (!candidate || typeof candidate !== 'object') continue;
      const entry = candidate as ModelCatalogEntry;
      if (!entry.id || !entry.cost) continue;
      modelCatalogEntryToCapabilityDeclaration(entry);
      fetched.set(entry.id, entry);
    }

    if (remoteCatalogs.get(url) !== state || generation !== state.generation) return getCatalogSize();

    if (options?.mode === 'replace') {
      state.entries = fetched;
    } else {
      const merged = new Map(state.entries);
      for (const [id, entry] of fetched) merged.set(id, entry);
      state.entries = merged;
    }
    state.etag = response.headers.get('etag') ?? undefined;
    state.lastFetchedAt = Date.now();
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    // A failed refresh leaves the last published directory intact.
  }

  return getCatalogSize();
}

/** Calculate cost, leaving unavailable components unknown instead of free. */
export function calculateDynamicModelCost(
  modelId: string,
  usage: ModelCostUsage,
  fallbackCostRates?: ModelPriceDescriptor
): CostCalculationResult {
  const entry = registeredCatalog.get(modelId) ?? findRemoteEntry(modelId);
  return calculateModelCost(entry?.cost ?? fallbackCostRates, usage);
}

export function calculateModelCost(
  pricing: ModelPriceDescriptor | undefined,
  usage: ModelCostUsage
): CostCalculationResult {
  const rates = pricing ? resolveRates(pricing, usage) : undefined;
  const inputCostUsd = costFor(usage.inputTokens, rates?.inputPerMillionUsd);
  const outputCostUsd = costFor(usage.outputTokens, rates?.outputPerMillionUsd);
  const cacheReadCostUsd = costFor(usage.cacheReadTokens ?? 0, rates?.cacheReadPerMillionUsd);
  const cacheWriteCostUsd = calculateCacheWriteCost(pricing, rates, usage);
  const costs = [inputCostUsd, outputCostUsd, cacheReadCostUsd, cacheWriteCostUsd];
  const activeCosts = costs.filter((_, index) => usageComponentTokens(usage, index) > 0);
  const knownActiveCount = activeCosts.filter((cost) => cost !== null).length;
  const hasUnknownActiveCost = activeCosts.some((cost) => cost === null);
  const totalCostUsd = hasUnknownActiveCost ? null : costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const savedCostByCacheUsd =
    cacheReadTokens === 0
      ? 0
      : rates?.inputPerMillionUsd !== undefined && rates.cacheReadPerMillionUsd !== undefined
        ? Math.max(0, (cacheReadTokens / 1_000_000) * (rates.inputPerMillionUsd - rates.cacheReadPerMillionUsd))
        : null;

  return {
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    totalCostUsd,
    savedCostByCacheUsd,
    status: !hasUnknownActiveCost ? 'known' : knownActiveCount === 0 ? 'unknown' : 'partial'
  };
}

function resolveRates(
  pricing: ModelPriceDescriptor,
  usage: { promptTokens?: number; serviceTier?: string }
): ModelPriceRateOverrides | undefined {
  let rates: ModelPriceRateOverrides = pricing;
  if (pricing.serviceTierRates) {
    const serviceTier = usage.serviceTier;
    if (!serviceTier || !pricing.serviceTierRates[serviceTier]) return undefined;
    rates = { ...rates, ...pricing.serviceTierRates[serviceTier] };
  }
  if (pricing.promptLengthTiers?.length) {
    if (usage.promptTokens === undefined) return undefined;
    const tier = [...pricing.promptLengthTiers]
      .filter((candidate) => candidate.minimumPromptTokens <= usage.promptTokens!)
      .sort((left, right) => right.minimumPromptTokens - left.minimumPromptTokens)[0];
    if (tier) rates = { ...rates, ...tier.rates };
  }
  return rates;
}

function calculateCacheWriteCost(
  pricing: ModelPriceDescriptor | undefined,
  rates: ModelPriceRateOverrides | undefined,
  usage: {
    cacheWriteTokens?: number;
    cacheWrite5mTokens?: number;
    cacheWrite1hTokens?: number;
  }
): number | null {
  const totalTokens = usage.cacheWriteTokens ?? (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0);
  const ttlRates = pricing?.cacheWritePerMillionUsdByTtl;
  if (!ttlRates || Object.keys(ttlRates).length === 0 || totalTokens === 0) {
    return costFor(totalTokens, rates?.cacheWritePerMillionUsd);
  }

  const hasDurationUsage = usage.cacheWrite5mTokens !== undefined || usage.cacheWrite1hTokens !== undefined;
  if (!hasDurationUsage) return null;
  const fiveMinuteTokens = usage.cacheWrite5mTokens ?? 0;
  const oneHourTokens = usage.cacheWrite1hTokens ?? 0;
  const residualTokens = totalTokens - fiveMinuteTokens - oneHourTokens;
  if (residualTokens < 0) return null;

  const fiveMinuteCost = costFor(fiveMinuteTokens, ttlRates['5m']);
  const oneHourCost = costFor(oneHourTokens, ttlRates['1h']);
  const residualCost = costFor(residualTokens, rates?.cacheWritePerMillionUsd);
  if (fiveMinuteCost === null || oneHourCost === null || residualCost === null) return null;
  return fiveMinuteCost + oneHourCost + residualCost;
}

function usageComponentTokens(usage: ModelCostUsage, index: number): number {
  switch (index) {
    case 0:
      return usage.inputTokens;
    case 1:
      return usage.outputTokens;
    case 2:
      return usage.cacheReadTokens ?? 0;
    default:
      return usage.cacheWriteTokens ?? (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0);
  }
}

function costFor(tokens: number, ratePerMillionUsd: number | undefined): number | null {
  if (tokens === 0) return 0;
  if (ratePerMillionUsd === undefined || !Number.isFinite(ratePerMillionUsd) || ratePerMillionUsd < 0) return null;
  return (tokens / 1_000_000) * ratePerMillionUsd;
}

function findRemoteEntry(modelId: string): ModelCatalogEntry | undefined {
  const sources = [...remoteCatalogs.values()].sort((left, right) => right.lastFetchedAt - left.lastFetchedAt);
  for (const source of sources) {
    const entry = source.entries.get(modelId);
    if (entry) return entry;
  }
  return undefined;
}

function getCatalogSize(): number {
  const ids = new Set(registeredCatalog.keys());
  for (const source of remoteCatalogs.values()) {
    for (const id of source.entries.keys()) ids.add(id);
  }
  return ids.size;
}

/** Reset local and remote catalog state for tests or explicit cache invalidation. */
export function clearCostCache(): void {
  registeredCatalog.clear();
  remoteCatalogs.clear();
}
