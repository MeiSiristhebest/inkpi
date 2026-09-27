import {
  type ModelCatalogEntry,
  modelCatalogEntryToCapabilityDeclaration,
  modelCatalogEntryToConfig
} from './catalog.js';
import { type ProviderHandler, getProvider } from './providers.js';
import type { ModelConfig, ProviderType } from './types.js';

export type ModelAuthenticationKind = 'none' | 'api-key' | 'oauth' | 'custom';

export interface ModelAuthenticationDescriptor {
  kind: ModelAuthenticationKind;
  required: boolean;
  /** Environment variable name only; never store the credential value here. */
  envVar?: string;
  /** Non-secret keyring/session reference, if the host supplies one. */
  credentialRef?: string;
}

export type ModelAvailabilityStatus = 'unknown' | 'available' | 'degraded' | 'unavailable';

export interface ModelAvailabilityDescriptor {
  status: ModelAvailabilityStatus;
  checkedAt?: number;
  reason?: string;
}

export interface ModelTransportDescriptor {
  kind: 'openai-compatible' | 'anthropic' | 'ollama' | 'custom';
  baseUrl?: string;
}

export interface ModelRouteDescriptor {
  canonicalId: string;
  provider: string;
  /** Provider-native model identifier. OpenRouter keeps slash-qualified ids intact. */
  modelId: string;
  baseUrl?: string;
  transport: ModelTransportDescriptor;
  authentication: ModelAuthenticationDescriptor;
  availability: ModelAvailabilityDescriptor;
  pricing?: ModelPricingDescriptor;
}

/** Canonical identity is provider-independent and contains no executable route data. */
export interface CanonicalModelIdentity {
  canonicalId: string;
  name: string;
  aliases: readonly string[];
}

/** Pricing is catalog metadata, not a transport or credential concern. */
export interface ModelPricingDescriptor {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
}

/** JSON-safe catalog metadata. Executable handlers live in the manager registry. */
export interface ModelCatalogV2Entry
  extends Omit<
    ModelCatalogEntry,
    'contextWindow' | 'maxTokens' | 'supportsThinking' | 'supportsTools' | 'supportsVision' | 'cost'
  > {
  /** Stable identity independent of provider aliases or display names. */
  canonicalId?: string;
  /** V2 metadata is sparse: omitted capability facts remain unknown. */
  contextWindow?: number;
  maxTokens?: number;
  supportsThinking?: boolean;
  supportsTools?: boolean;
  supportsVision?: boolean;
  cost?: ModelPricingDescriptor;
  pricing?: ModelPricingDescriptor;
  /** Explicit legacy/user-facing aliases. */
  aliases?: readonly string[];
  /** Transport identity may differ from the catalog identity. */
  route?: {
    provider?: string;
    modelId?: string;
    baseUrl?: string;
  };
  authentication?: ModelAuthenticationDescriptor;
  availability?: ModelAvailabilityDescriptor;
}

export interface ExecutableModelRoute {
  route: ModelRouteDescriptor;
  config: ModelConfig;
  handler: ProviderHandler;
}

interface CatalogRecord {
  entry: ModelCatalogV2Entry;
  route: ModelRouteDescriptor;
}

/**
 * Runtime catalog v2: canonical identities and JSON-safe route metadata are
 * separated from executable provider handlers and credentials.
 */
export class ModelCatalogV2 {
  private records = new Map<string, CatalogRecord>();
  /** null marks an ambiguous short alias shared by multiple routes. */
  private aliases = new Map<string, string | null>();
  private handlers = new Map<string, ProviderHandler>();

  /** V2 is intentionally opt-in; callers register canonical identities explicitly. */
  constructor(entries: readonly ModelCatalogV2Entry[] = []) {
    for (const entry of entries) this.registerModel(entry);
  }

  public registerModel(entry: ModelCatalogV2Entry): void {
    modelCatalogEntryToCapabilityDeclaration(toLegacyCatalogEntry(entry));
    const canonicalId = normalizeRequired(entry.canonicalId ?? entry.id, 'canonical model id');
    const route = createRouteDescriptor(entry, canonicalId);
    const aliases = collectAliases(entry, canonicalId, route.modelId).map((alias) =>
      normalizeRequired(alias, 'model alias').toLowerCase()
    );
    const explicitAliases = new Set(
      (entry.aliases ?? []).map((alias) => normalizeRequired(alias, 'model alias').toLowerCase())
    );

    if (this.records.has(canonicalId)) this.removeAliasesFor(canonicalId);
    for (const alias of aliases) {
      const current = this.aliases.get(alias);
      if (current && current !== canonicalId && explicitAliases.has(alias)) {
        throw new Error(`Model alias '${alias}' is already mapped to '${current}'.`);
      }
      if (current && current !== canonicalId) this.aliases.set(alias, null);
      else if (current === null && explicitAliases.has(alias)) {
        throw new Error(`Model alias '${alias}' is ambiguous.`);
      } else this.aliases.set(alias, canonicalId);
    }
    this.records.set(canonicalId, { entry: { ...entry, canonicalId }, route });
    this.rebuildAliases();
  }

  public unregisterModel(idOrAlias: string): boolean {
    const canonicalId = this.resolveCanonicalId(idOrAlias);
    if (!canonicalId) return false;
    this.removeAliasesFor(canonicalId);
    const removed = this.records.delete(canonicalId);
    if (removed) this.rebuildAliases();
    return removed;
  }

  public registerAlias(alias: string, canonicalIdOrAlias: string): void {
    const normalizedAlias = normalizeRequired(alias, 'model alias').toLowerCase();
    const canonicalId = this.resolveCanonicalId(canonicalIdOrAlias) ?? canonicalIdOrAlias;
    if (!this.records.has(canonicalId)) {
      throw new Error(`Cannot register alias '${alias}': model '${canonicalIdOrAlias}' is not registered.`);
    }

    const current = this.aliases.get(normalizedAlias);
    if (current !== undefined && current !== canonicalId) {
      throw new Error(
        current === null
          ? `Model alias '${alias}' is ambiguous.`
          : `Model alias '${alias}' is already mapped to '${current}'.`
      );
    }
    this.aliases.set(normalizedAlias, canonicalId);
  }

  public getModel(idOrAlias: string): ModelCatalogV2Entry | undefined {
    const canonicalId = this.resolveCanonicalId(idOrAlias);
    return canonicalId ? this.records.get(canonicalId)?.entry : undefined;
  }

  public getIdentity(idOrAlias: string): CanonicalModelIdentity | undefined {
    const canonicalId = this.resolveCanonicalId(idOrAlias);
    const entry = canonicalId ? this.records.get(canonicalId)?.entry : undefined;
    if (!entry || !canonicalId) return undefined;
    return {
      canonicalId,
      name: entry.name,
      aliases: collectAliases(entry, canonicalId, this.records.get(canonicalId)!.route.modelId)
    };
  }

  public getPricing(idOrAlias: string): ModelPricingDescriptor | undefined {
    const canonicalId = this.resolveCanonicalId(idOrAlias);
    const entry = canonicalId ? this.records.get(canonicalId)?.entry : undefined;
    const pricing = entry?.pricing ?? entry?.cost;
    return pricing ? { ...pricing } : undefined;
  }

  public getRoute(idOrAlias: string): ModelRouteDescriptor | undefined {
    const canonicalId = this.resolveCanonicalId(idOrAlias);
    const route = canonicalId ? this.records.get(canonicalId)?.route : undefined;
    return route ? cloneRoute(route) : undefined;
  }

  public getAllModels(): ModelCatalogV2Entry[] {
    return [...this.records.values()].map(({ entry }) => entry);
  }

  public getAliases(): Record<string, string> {
    return Object.fromEntries(
      [...this.aliases.entries()]
        .filter((entry): entry is [string, string] => entry[1] !== null)
        .sort(([left], [right]) => left.localeCompare(right))
    );
  }

  public setAvailability(idOrAlias: string, availability: ModelAvailabilityDescriptor): ModelAvailabilityDescriptor {
    validateAvailability(availability);
    const canonicalId = this.requireCanonicalId(idOrAlias);
    const record = this.records.get(canonicalId);
    if (!record) throw new Error(`Model '${idOrAlias}' is not registered.`);
    record.route = { ...record.route, availability: { ...availability } };
    record.entry = { ...record.entry, availability: { ...availability } };
    return cloneAvailability(record.route.availability);
  }

  /** Register an executable handler separately from JSON-safe model metadata. */
  public registerHandler(provider: string, handler: ProviderHandler): void {
    const normalizedProvider = normalizeRequired(provider, 'provider').toLowerCase();
    if (typeof handler !== 'function') throw new Error('Model provider handler must be a function.');
    this.handlers.set(normalizedProvider, handler);
  }

  public resolveExecutableModel(idOrAlias: string): ExecutableModelRoute {
    const canonicalId = this.requireCanonicalId(idOrAlias);
    const record = this.records.get(canonicalId);
    if (!record) throw new Error(`Model '${idOrAlias}' is not registered.`);

    const handler =
      this.handlers.get(record.route.provider.toLowerCase()) ?? getProvider(record.route.provider as ProviderType);
    const baseConfig = modelCatalogEntryToConfig(toLegacyCatalogEntry(record.entry));
    const config: ModelConfig = {
      ...baseConfig,
      id: record.route.modelId,
      provider: record.route.provider as ProviderType,
      ...(record.route.baseUrl ? { baseUrl: record.route.baseUrl } : {})
    };

    return {
      route: cloneRoute(record.route),
      config,
      handler
    };
  }

  private resolveCanonicalId(idOrAlias: string): string | undefined {
    if (typeof idOrAlias !== 'string' || idOrAlias.trim().length === 0) return undefined;
    const query = idOrAlias.trim();
    if (this.records.has(query)) return query;
    const mapped = this.aliases.get(query.toLowerCase());
    return mapped ?? undefined;
  }

  private requireCanonicalId(idOrAlias: string): string {
    const canonicalId = this.resolveCanonicalId(idOrAlias);
    if (!canonicalId) throw new Error(`Model '${idOrAlias}' is not registered.`);
    return canonicalId;
  }

  private removeAliasesFor(canonicalId: string): void {
    for (const [alias, mappedId] of this.aliases) {
      if (mappedId === canonicalId) this.aliases.delete(alias);
    }
  }

  private rebuildAliases(): void {
    this.aliases.clear();
    for (const [canonicalId, record] of this.records) {
      for (const alias of collectAliases(record.entry, canonicalId, record.route.modelId)) {
        const normalized = normalizeRequired(alias, 'model alias').toLowerCase();
        const current = this.aliases.get(normalized);
        if (current !== undefined && current !== canonicalId) this.aliases.set(normalized, null);
        else this.aliases.set(normalized, canonicalId);
      }
    }
  }
}

function toLegacyCatalogEntry(entry: ModelCatalogV2Entry): ModelCatalogEntry {
  return {
    ...entry,
    contextWindow: entry.contextWindow ?? 1,
    maxTokens: entry.maxTokens ?? 1,
    supportsThinking: entry.supportsThinking ?? false,
    supportsTools: entry.supportsTools ?? false,
    supportsVision: entry.supportsVision,
    cost: entry.cost ?? { inputPerMillionUsd: 0, outputPerMillionUsd: 0 }
  };
}

function createRouteDescriptor(entry: ModelCatalogV2Entry, canonicalId: string): ModelRouteDescriptor {
  const provider = normalizeRequired(entry.route?.provider ?? entry.provider, 'route provider');
  const modelId = normalizeRequired(entry.route?.modelId ?? defaultRouteModelId(entry.id, provider), 'route model id');
  const authentication = entry.authentication ? { ...entry.authentication } : defaultAuthentication(provider);
  const availability = entry.availability ? { ...entry.availability } : { status: 'unknown' as const };
  validateAuthentication(authentication);
  validateAvailability(availability);

  return {
    canonicalId,
    provider,
    modelId,
    ...(entry.route?.baseUrl ? { baseUrl: entry.route.baseUrl } : {}),
    transport: {
      kind: transportKind(provider),
      ...(entry.route?.baseUrl ? { baseUrl: entry.route.baseUrl } : {})
    },
    authentication,
    availability,
    ...((entry.pricing ?? entry.cost) ? { pricing: { ...(entry.pricing ?? entry.cost)! } } : {})
  };
}

function collectAliases(entry: ModelCatalogV2Entry, canonicalId: string, routeModelId: string): string[] {
  // Short ids remain convenient when unique; registerModel marks collisions as
  // ambiguous instead of silently selecting one provider route.
  return [...new Set([canonicalId, entry.id, routeModelId, shortModelId(entry.id), ...(entry.aliases ?? [])])];
}

function defaultRouteModelId(id: string, provider: string): string {
  // OpenRouter accepts provider-qualified ids (for example openai/gpt-4o).
  // Never strip that identity while constructing its transport request.
  return provider.toLowerCase() === 'openrouter' ? id : shortModelId(id);
}

function shortModelId(id: string): string {
  const separator = id.indexOf('/');
  return separator >= 0 ? id.slice(separator + 1) : id;
}

function transportKind(provider: string): ModelTransportDescriptor['kind'] {
  const normalized = provider.toLowerCase();
  if (normalized === 'anthropic' || normalized === 'claude') return 'anthropic';
  if (normalized === 'ollama') return 'ollama';
  if (['openai', 'openrouter', 'deepseek', 'groq', 'mistral', 'xai', 'z-ai'].includes(normalized)) {
    return 'openai-compatible';
  }
  return 'custom';
}

function defaultAuthentication(provider: string): ModelAuthenticationDescriptor {
  if (provider.toLowerCase() === 'ollama') return { kind: 'none', required: false };
  return { kind: 'api-key', required: true };
}

function validateAuthentication(authentication: ModelAuthenticationDescriptor): void {
  if (!authentication || typeof authentication !== 'object') {
    throw new Error('Model authentication descriptor must be an object.');
  }
  if (!['none', 'api-key', 'oauth', 'custom'].includes(authentication.kind)) {
    throw new Error(`Invalid model authentication kind: ${String(authentication.kind)}`);
  }
  if (typeof authentication.required !== 'boolean') {
    throw new Error('Model authentication required must be boolean.');
  }
  for (const [name, value] of [
    ['envVar', authentication.envVar],
    ['credentialRef', authentication.credentialRef]
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
      throw new Error(`Model authentication ${name} must be a non-empty string when provided.`);
    }
  }
}

function validateAvailability(availability: ModelAvailabilityDescriptor): void {
  if (!availability || typeof availability !== 'object') {
    throw new Error('Model availability descriptor must be an object.');
  }
  if (!['unknown', 'available', 'degraded', 'unavailable'].includes(availability.status)) {
    throw new Error(`Invalid model availability status: ${String(availability.status)}`);
  }
  if (availability.checkedAt !== undefined && !Number.isFinite(availability.checkedAt)) {
    throw new Error('Model availability checkedAt must be finite.');
  }
  if (availability.reason !== undefined && typeof availability.reason !== 'string') {
    throw new Error('Model availability reason must be a string.');
  }
}

function normalizeRequired(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

function cloneAvailability(availability: ModelAvailabilityDescriptor): ModelAvailabilityDescriptor {
  return { ...availability };
}

function cloneRoute(route: ModelRouteDescriptor): ModelRouteDescriptor {
  return {
    ...route,
    transport: { ...route.transport },
    authentication: { ...route.authentication },
    availability: cloneAvailability(route.availability),
    ...(route.pricing ? { pricing: { ...route.pricing } } : {})
  };
}
