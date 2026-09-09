import type { AiTask } from '@inkpi/protocol';
import {
  createRuntimeCacheKey,
  shouldInvalidateCacheEntry,
  stableSerialize,
  type CacheInvalidationEvent,
  type RuntimeCacheCoordinatorPort
} from './cache-contract.js';
import type { ContextFragment, ContextPacket, ContextProvider, ContextRequest } from './types.js';

const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_CONTEXT_CACHE_ENTRIES = 64;
const CHARS_PER_TOKEN = 4;

export interface ContextCacheOptions {
  /** Context compilation is cached by default; set false or maxEntries to 0 to disable it. */
  enabled?: boolean;
  maxEntries?: number;
}

export interface ContextPipelineOptions {
  maxTokens?: number;
  cache?: ContextCacheOptions;
  cacheCoordinator?: RuntimeCacheCoordinatorPort;
}

export interface ContextPipelineCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  invalidations: number;
}

interface ContextCacheEntry {
  packet: ContextPacket;
  projectRevision?: number;
}

export class ContextPipeline {
  private readonly providers = new Map<string, ContextProvider>();
  private readonly cache = new Map<string, ContextCacheEntry>();
  private readonly maxTokens: number;
  private readonly cacheEnabled: boolean;
  private readonly cacheMaxEntries: number;
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheEvictions = 0;
  private cacheInvalidations = 0;
  private readonly cacheCoordinator?: RuntimeCacheCoordinatorPort;
  private cacheInvalidationUnsubscribe?: () => void;

  constructor(options: ContextPipelineOptions = {}) {
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.cacheEnabled = options.cache?.enabled ?? true;
    const maxEntries = options.cache?.maxEntries ?? DEFAULT_CONTEXT_CACHE_ENTRIES;
    this.cacheMaxEntries = Number.isFinite(maxEntries)
      ? Math.max(0, Math.floor(maxEntries))
      : DEFAULT_CONTEXT_CACHE_ENTRIES;
    this.cacheCoordinator = options.cacheCoordinator;
    this.cacheInvalidationUnsubscribe = this.cacheCoordinator?.onInvalidate('context', (event) =>
      this.clearCache(event)
    );
  }

  register(provider: ContextProvider): void {
    if (!provider.id.trim()) throw new Error('Context provider id must not be empty');
    if (this.providers.has(provider.id)) {
      throw new Error(`Context provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    this.clearCache();
  }

  unregister(providerId: string): boolean {
    const removed = this.providers.delete(providerId);
    if (removed) this.clearCache();
    return removed;
  }

  list(): ContextProvider[] {
    return [...this.providers.values()];
  }

  /** Clear compiled packets after an external project or retrieval-index update. */
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

  cacheStats(): ContextPipelineCacheStats {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      evictions: this.cacheEvictions,
      invalidations: this.cacheInvalidations
    };
  }

  /** Stop listening to a shared coordinator when the owning Runtime is disposed. */
  dispose(): void {
    this.cacheInvalidationUnsubscribe?.();
    this.cacheInvalidationUnsubscribe = undefined;
  }

  async build(task: AiTask, signal?: AbortSignal): Promise<ContextPacket> {
    if (signal?.aborted) throw abortError();
    const cacheKey = this.getCacheKey(task);
    const cached = this.getCached(cacheKey);
    if (cached) return cached;

    const request: ContextRequest = {
      task,
      signal,
      purpose: task.kind,
      projectRevision: task.input.selection?.revision,
      metadata: task.contextPolicy?.metadata
    };
    const fragments: ContextFragment[] = [];
    if (task.input.text) {
      fragments.push({
        id: `task-input:${hash(stableSerialize({
          documentId: task.input.documentId,
          selection: task.input.selection,
          text: task.input.text
        }))}`,
        source: 'task-input',
        kind: 'input',
        text: task.input.text,
        priority: Number.MAX_SAFE_INTEGER
      });
    }

    const requestedProviders = task.contextPolicy?.providerIds;
    for (const provider of this.providers.values()) {
      if (requestedProviders && !requestedProviders.includes(provider.id)) continue;
      if (provider.supports && !(await provider.supports(request))) continue;
      if (signal?.aborted) throw abortError();
      const provided = await provider.provide(request, signal);
      fragments.push(...provided);
    }

    const packet = buildPacket(fragments, task.contextPolicy?.maxTokens ?? this.maxTokens, request.projectRevision);
    if (task.contextPolicy?.maxFragments !== undefined && packet.fragments.length > task.contextPolicy.maxFragments) {
      const limited = packet.fragments.slice(0, Math.max(0, task.contextPolicy.maxFragments));
      const limitedPacket = buildPacket(
        limited,
        task.contextPolicy.maxTokens ?? this.maxTokens,
        request.projectRevision
      );
      limitedPacket.metadata = task.contextPolicy?.metadata;
      this.setCached(cacheKey, limitedPacket);
      return limitedPacket;
    }
    packet.metadata = task.contextPolicy?.metadata;
    this.setCached(cacheKey, packet);
    return packet;
  }

  private getCacheKey(task: AiTask): string {
    return createContextCacheKey(task, [...this.providers.keys()], this.maxTokens);
  }

  private getCached(cacheKey: string): ContextPacket | undefined {
    if (!this.cacheEnabled || this.cacheMaxEntries === 0) return undefined;
    const entry = this.cache.get(cacheKey);
    if (!entry) {
      this.cacheMisses += 1;
      this.cacheCoordinator?.record('context', 'miss');
      return undefined;
    }
    this.cacheHits += 1;
    this.cacheCoordinator?.record('context', 'hit');
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, entry);
    return clonePacket(entry.packet);
  }

  private setCached(cacheKey: string, packet: ContextPacket): void {
    if (!this.cacheEnabled || this.cacheMaxEntries === 0) return;
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, {
      packet: clonePacket(packet),
      projectRevision: packet.projectRevision
    });
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.cacheEvictions += 1;
      this.cacheCoordinator?.record('context', 'eviction');
    }
  }
}

/**
 * Build the compilation identity without the task id. Stable instruction and
 * skill versions remain explicit so a registration update cannot reuse an old
 * compiled packet.
 */
export function createContextCacheKey(task: AiTask, providerIds: readonly string[], maxTokens: number): string {
  const metadata = asRecord(task.metadata);
  const contextMetadata = asRecord(task.contextPolicy?.metadata);
  const projectRevision = firstNumber(
    task.input.selection?.revision,
    metadata?.projectRevision,
    contextMetadata?.projectRevision
  );
  const instructionVersion = firstString(metadata?.instructionVersion, contextMetadata?.instructionVersion);
  const skillVersion = firstString(metadata?.skillVersion, contextMetadata?.skillVersion);
  const inputFingerprint = hash(stableSerialize(task.input));
  const intentFingerprint = hash(stableSerialize(task.intent));
  const contextFingerprint =
    firstString(metadata?.contextFingerprint, contextMetadata?.contextFingerprint) ??
    hash(stableSerialize({ input: task.input, intent: task.intent }));
  const model = firstString(metadata?.model, metadata?.modelId, contextMetadata?.model, contextMetadata?.modelId);

  return createRuntimeCacheKey({
    layer: 'context',
    taskKind: task.kind,
    instructionVersion,
    skillVersion,
    projectRevision,
    contextFingerprint,
    model,
    identity: {
      contextPolicy: {
        includeProjectState: task.contextPolicy?.includeProjectState,
        includeSelection: task.contextPolicy?.includeSelection,
        maxFragments: task.contextPolicy?.maxFragments,
        maxTokens: task.contextPolicy?.maxTokens,
        metadata: contextMetadata,
        providerIds: task.contextPolicy?.providerIds
      },
      inputFingerprint,
      intentFingerprint,
      maxTokens,
      providers: [...providerIds]
    }
  });
}

function clonePacket(packet: ContextPacket): ContextPacket {
  try {
    return structuredClone(packet);
  } catch {
    return {
      ...packet,
      fragments: packet.fragments.map((fragment) => ({ ...fragment }))
    };
  }
}

function buildPacket(input: ContextFragment[], maxTokens: number, projectRevision?: number): ContextPacket {
  const limit = Math.max(0, Math.floor(maxTokens));
  const unique = new Map<string, ContextFragment>();
  for (const fragment of input) {
    if (!fragment.id || unique.has(fragment.id)) continue;
    unique.set(fragment.id, {
      ...fragment,
      priority: fragment.priority ?? 0,
      tokenEstimate: fragment.tokenEstimate ?? fragment.estimatedTokens ?? estimateTokens(fragment)
    });
  }

  const ordered = [...unique.values()].sort((left, right) => {
    const scoreDelta = score(right) - score(left);
    return scoreDelta || left.id.localeCompare(right.id);
  });
  const accepted: ContextFragment[] = [];
  let tokenEstimate = 0;
  let truncated = false;

  for (const fragment of ordered) {
    const remaining = limit - tokenEstimate;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const fragmentTokens = fragment.tokenEstimate ?? fragment.estimatedTokens ?? estimateTokens(fragment);
    if (fragmentTokens <= remaining) {
      accepted.push(fragment);
      tokenEstimate += fragmentTokens;
      continue;
    }

    if (fragment.text && remaining > 0) {
      const text = fragment.text.slice(0, remaining * CHARS_PER_TOKEN);
      accepted.push({ ...fragment, text, tokenEstimate: estimateTokens({ text }) });
      tokenEstimate += estimateTokens({ text });
    }
    truncated = true;
    break;
  }

  const text = accepted
    .map((fragment) => fragment.text ?? serializeData(fragment.data ?? fragment.content))
    .filter(Boolean)
    .join('\n\n');
  return {
    fragments: accepted,
    text,
    tokenEstimate,
    fingerprint: fingerprint(accepted, projectRevision),
    truncated,
    projectRevision
  };
}

function estimateTokens(fragment: Pick<ContextFragment, 'text' | 'data' | 'content'>): number {
  const value = fragment.text ?? serializeData(fragment.data ?? fragment.content);
  return value ? Math.max(1, Math.ceil(value.length / CHARS_PER_TOKEN)) : 0;
}

function serializeData(data: unknown): string {
  if (data === undefined) return '';
  if (typeof data === 'string') return data;
  try {
    return stableSerialize(data);
  } catch {
    return String(data);
  }
}

function score(fragment: ContextFragment): number {
  return (
    (fragment.priority ?? 0) * 1_000_000 +
    (fragment.relevance ?? 0) * 10_000 +
    (fragment.dependency ?? 0) * 100 +
    (fragment.recency ?? 0)
  );
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function fingerprint(fragments: ContextFragment[], projectRevision?: number): string {
  const value = `${fragments
    .map((fragment) =>
      stableSerialize({
        id: fragment.id,
        source: fragment.source,
        kind: fragment.kind,
        text: fragment.text,
        content: fragment.data ?? fragment.content,
        priority: fragment.priority ?? 0,
        relevance: fragment.relevance ?? 0,
        recency: fragment.recency ?? 0,
        dependency: fragment.dependency ?? 0,
        tokenEstimate: fragment.tokenEstimate ?? fragment.estimatedTokens ?? estimateTokens(fragment)
      })
    )
    .join('\u0001')}\u0002revision:${projectRevision ?? ''}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function abortError(): Error {
  const error = new Error('Context building was cancelled');
  error.name = 'AbortError';
  return error;
}
