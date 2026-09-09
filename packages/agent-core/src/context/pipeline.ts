import type { AiTask } from '@inkpi/protocol';
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
}

export class ContextPipeline {
  private readonly providers = new Map<string, ContextProvider>();
  private readonly cache = new Map<string, ContextPacket>();
  private readonly maxTokens: number;
  private readonly cacheEnabled: boolean;
  private readonly cacheMaxEntries: number;

  constructor(options: ContextPipelineOptions = {}) {
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.cacheEnabled = options.cache?.enabled ?? true;
    const maxEntries = options.cache?.maxEntries ?? DEFAULT_CONTEXT_CACHE_ENTRIES;
    this.cacheMaxEntries = Number.isFinite(maxEntries)
      ? Math.max(0, Math.floor(maxEntries))
      : DEFAULT_CONTEXT_CACHE_ENTRIES;
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
  clearCache(): void {
    this.cache.clear();
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
        id: `task-input:${task.id}`,
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
    return stableSerialize({
      maxTokens: this.maxTokens,
      providers: [...this.providers.keys()],
      task
    });
  }

  private getCached(cacheKey: string): ContextPacket | undefined {
    if (!this.cacheEnabled || this.cacheMaxEntries === 0) return undefined;
    const packet = this.cache.get(cacheKey);
    if (!packet) return undefined;
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, packet);
    return clonePacket(packet);
  }

  private setCached(cacheKey: string, packet: ContextPacket): void {
    if (!this.cacheEnabled || this.cacheMaxEntries === 0) return;
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, clonePacket(packet));
    while (this.cache.size > this.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
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

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
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
