import type {
  RuntimeModelCatalogEntry,
  RuntimeModelProviderProbeParams,
  RuntimeModelProviderProbeResult
} from '@inkpi/protocol';

export interface ModelProviderProbeOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
  resolveCredential?: (credentialRef: string) => Promise<string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 6000;

/** Probe a configured provider from Runtime so WebView CSP does not own network access. */
export async function probeModelProvider(
  params: RuntimeModelProviderProbeParams,
  options: ModelProviderProbeOptions = {}
): Promise<RuntimeModelProviderProbeResult> {
  if (params.provider.trim().toLowerCase() === 'openai-chatgpt-plan') {
    throw new Error('ChatGPT plan accounts must be probed through the account Runtime API');
  }
  const endpoint = providerModelsEndpoint(params.provider, params.baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = params.credentialRef ? (await options.resolveCredential?.(params.credentialRef))?.trim() : undefined;
  if (params.credentialRef && !options.resolveCredential) {
    throw new Error('Model credential broker is not configured');
  }
  const provider = params.provider.trim().toLowerCase();
  if (apiKey) {
    if (provider.includes('anthropic')) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (provider.includes('google') || provider.includes('gemini')) {
      headers['x-goog-api-key'] = apiKey;
    } else if (provider !== 'ollama') {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  const start = (options.now ?? Date.now)();
  const response = await (options.fetchImpl ?? fetch)(endpoint, {
    method: 'GET',
    headers,
    redirect: 'error',
    signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  });

  const latency = Math.max(0, (options.now ?? Date.now)() - start);
  const catalogModels = response.ok ? await readModelCatalog(response) : [];
  return {
    status: response.status,
    latency,
    modelIds: catalogModels.map((model) => model.id),
    catalogModels
  };
}

function providerModelsEndpoint(provider: string, baseUrl: string): string {
  if (!provider.trim()) throw new Error('Provider is required');
  if (!baseUrl.trim()) throw new Error('Model provider base URL is required');

  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Model provider URL must use HTTP or HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Model provider URL must not contain credentials, query, or fragment data');
  }

  const normalizedProvider = provider.toLowerCase();
  let path = url.pathname.replace(/\/+$/, '');
  if (normalizedProvider === 'ollama') {
    path = path.replace(/\/v1$/i, '');
    url.pathname = `${path}/api/tags`.replace(/^\/\//, '/');
  } else if (normalizedProvider.includes('google') || normalizedProvider.includes('gemini')) {
    if (!/\/v1beta$/i.test(path)) path = `${path}/v1beta`;
    url.pathname = `${path}/models`;
  } else {
    if (!/\/v1$/i.test(path)) path = `${path}/v1`;
    url.pathname = `${path}/models`;
  }
  return url.toString();
}

async function readModelCatalog(response: Response): Promise<RuntimeModelCatalogEntry[]> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return [];
  }
  if (!isRecord(value)) return [];

  const entries = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : [];
  const byId = new Map<string, RuntimeModelCatalogEntry>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const rawId = entry.id ?? entry.slug ?? entry.name ?? entry.model;
    if (typeof rawId !== 'string' || !rawId.trim()) continue;
    const id = rawId.replace(/^models\//, '').trim();
    const model: RuntimeModelCatalogEntry = { id };
    const name = firstString(entry.display_name, entry.displayName, entry.name);
    if (name && name !== id) model.name = name;
    const contextTokens = firstNumber(
      entry.contextTokens,
      entry.context_tokens,
      entry.contextWindow,
      entry.context_window,
      entry.inputTokenLimit
    );
    if (contextTokens !== undefined) model.contextTokens = contextTokens;
    const maxOutputTokens = firstNumber(
      entry.maxOutputTokens,
      entry.max_output_tokens,
      entry.maxTokens,
      entry.max_tokens,
      entry.outputTokenLimit
    );
    if (maxOutputTokens !== undefined) model.maxOutputTokens = maxOutputTokens;
    const inputModalities = firstStringArray(entry.inputModalities, entry.input_modalities);
    if (inputModalities) model.inputModalities = inputModalities;
    const promptPrice = firstStringOrNumber(
      entry.promptPricePerToken,
      entry.prompt_price_per_token,
      entry.inputPricePerToken,
      entry.input_cost_per_token
    );
    if (promptPrice !== undefined) model.promptPricePerToken = promptPrice;
    const completionPrice = firstStringOrNumber(
      entry.completionPricePerToken,
      entry.completion_price_per_token,
      entry.outputPricePerToken,
      entry.output_cost_per_token
    );
    if (completionPrice !== undefined) model.completionPricePerToken = completionPrice;
    byId.set(id, { ...byId.get(id), ...model });
  }
  return [...byId.values()];
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value !== 'number' && typeof value !== 'string') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function firstStringOrNumber(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return String(value);
  }
  return undefined;
}

function firstStringArray(...values: unknown[]): string[] | undefined {
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    const items = value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
    if (items.length > 0) return [...new Set(items)];
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
