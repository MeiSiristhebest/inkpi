import type { RuntimeModelProviderProbeParams, RuntimeModelProviderProbeResult } from '@inkpi/protocol';

export interface ModelProviderProbeOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 6000;

/** Probe a configured provider from Runtime so WebView CSP does not own network access. */
export async function probeModelProvider(
  params: RuntimeModelProviderProbeParams,
  options: ModelProviderProbeOptions = {}
): Promise<RuntimeModelProviderProbeResult> {
  const endpoint = providerModelsEndpoint(params.provider, params.baseUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  const apiKey = params.apiKey?.trim();
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
  return {
    status: response.status,
    latency,
    modelIds: response.ok ? await readModelIds(response) : []
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

async function readModelIds(response: Response): Promise<string[]> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return [];
  }
  if (!isRecord(value)) return [];

  const entries = Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const rawId = entry.id ?? entry.name ?? entry.model;
    if (typeof rawId !== 'string' || !rawId.trim()) continue;
    ids.add(rawId.replace(/^models\//, '').trim());
  }
  return [...ids];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
