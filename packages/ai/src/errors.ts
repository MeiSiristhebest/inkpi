/**
 * AI 包领域错误类型。
 * 这些错误用于在不支持的功能被使用时给出明确的失败信号，
 * 取代原先「静默映射 / 静默回落到假实现」的行为。
 */

export type ProviderErrorCode =
  | 'authentication'
  | 'invalid_request'
  | 'rate_limit'
  | 'transient_transport'
  | 'provider_unavailable'
  | 'unsupported_capability'
  | 'malformed_response'
  | 'context_overflow'
  | 'cancelled'
  | 'policy_refusal'
  | 'unknown';

export interface ProviderErrorInfo {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  provider?: string;
  status?: number;
  retryAfterMs?: number;
  maxDelayMs?: number;
  details?: unknown;
}

export interface ProviderErrorContext {
  provider?: string;
  status?: number;
  retryAfterMs?: number;
  maxDelayMs?: number;
  details?: unknown;
}

export interface ProviderErrorInit extends ProviderErrorContext {
  code: ProviderErrorCode;
  message: string;
  retryable?: boolean;
}

/** A normalized provider failure safe to carry across the stream boundary. */
export class ProviderError extends Error implements ProviderErrorInfo {
  public readonly code: ProviderErrorCode;
  public readonly retryable: boolean;
  public readonly provider?: string;
  public readonly status?: number;
  public readonly retryAfterMs?: number;
  public readonly maxDelayMs?: number;
  public readonly details?: unknown;

  constructor(init: ProviderErrorInit) {
    super(init.message);
    this.name = 'ProviderError';
    this.code = init.code;
    this.retryable = init.retryable ?? isProviderErrorRetryable(init.code);
    this.provider = init.provider;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.maxDelayMs = init.maxDelayMs;
    this.details = init.details;
  }
}

/**
 * Normalize provider/network failures without making retry decisions from an
 * arbitrary error message in callers. HTTP callers should pass the status.
 */
export function classifyProviderError(error: unknown, context: ProviderErrorContext = {}): ProviderErrorInfo {
  if (error instanceof ProviderError) return error;

  if (error instanceof ProviderNotImplementedError) {
    return new ProviderError({
      code: 'unsupported_capability',
      message: error.message,
      provider: context.provider ?? error.provider,
      status: context.status
    });
  }

  const candidate = asErrorRecord(error);
  const provider = context.provider ?? readString(candidate?.provider);
  const status = context.status ?? readStatus(candidate);
  const message =
    error instanceof Error
      ? error.message
      : (readString(candidate?.message) ?? String(error ?? 'Unknown provider error'));
  const retryAfterMs = readFiniteNumber(candidate?.retryAfterMs ?? candidate?.retryAfter);
  const maxDelayMs = readFiniteNumber(candidate?.maxDelayMs);
  const details = candidate?.details;

  if (candidate?.name === 'AbortError' || /\babort(?:ed|ion)?\b/i.test(message)) {
    return new ProviderError({ code: 'cancelled', message, provider, status, retryAfterMs, maxDelayMs, details });
  }

  const detailCode = asErrorRecord(candidate?.details)?.code;
  if (isContextOverflow(message, candidate?.code ?? detailCode)) {
    return new ProviderError({
      code: 'context_overflow',
      message,
      provider,
      status,
      retryable: false,
      retryAfterMs,
      maxDelayMs,
      details
    });
  }

  if (status !== undefined) {
    return new ProviderError({
      code: providerErrorCodeForStatus(status),
      message,
      provider,
      status,
      retryAfterMs,
      maxDelayMs,
      details
    });
  }

  if (/missing (?:an? )?api key|credential|authentication|unauthorized|forbidden/i.test(message)) {
    return new ProviderError({ code: 'authentication', message, provider, retryAfterMs, maxDelayMs, details });
  }
  if (/provider unavailable|service unavailable|temporarily unavailable/i.test(message)) {
    return new ProviderError({ code: 'provider_unavailable', message, provider, retryAfterMs, maxDelayMs, details });
  }
  if (/unsupported|not implemented|capability/i.test(message)) {
    return new ProviderError({ code: 'unsupported_capability', message, provider, retryAfterMs, maxDelayMs, details });
  }
  if (/malformed|invalid json|parse|stream ended|missing .*output|missing .*finish/i.test(message)) {
    return new ProviderError({ code: 'malformed_response', message, provider, retryAfterMs, maxDelayMs, details });
  }
  if (/refus|policy|safety/i.test(message)) {
    return new ProviderError({ code: 'policy_refusal', message, provider, retryAfterMs, maxDelayMs, details });
  }
  if (
    /timeout|timed out|network|fetch failed|failed to fetch|connection reset|connection refused|econn|enotfound|socket|temporar|transient/i.test(
      message
    )
  ) {
    return new ProviderError({ code: 'transient_transport', message, provider, retryAfterMs, maxDelayMs, details });
  }

  return new ProviderError({ code: 'unknown', message, provider, retryAfterMs, maxDelayMs, details });
}

export function providerHttpError(
  provider: string,
  status: number,
  statusText?: string,
  metadata?: Pick<ProviderErrorInit, 'retryAfterMs' | 'maxDelayMs' | 'details'>
): ProviderError {
  const suffix = statusText ? ` ${statusText}` : '';
  const message = `${provider} API Error: ${status}${suffix}`;
  return new ProviderError({
    code: isContextOverflow(message, undefined) ? 'context_overflow' : providerErrorCodeForStatus(status),
    message,
    provider,
    status,
    ...metadata
  });
}

function providerErrorCodeForStatus(status: number): ProviderErrorCode {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 408 || status === 425) return 'transient_transport';
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status <= 599) return 'provider_unavailable';
  if (status >= 400 && status <= 499) return 'invalid_request';
  return 'unknown';
}

function isProviderErrorRetryable(code: ProviderErrorCode): boolean {
  return code === 'rate_limit' || code === 'transient_transport' || code === 'provider_unavailable';
}

function asErrorRecord(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === 'object' ? (error as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isContextOverflow(message: string, code: unknown): boolean {
  return (
    code === 'context_overflow' ||
    code === 'context_length_exceeded' ||
    /context(?:\s+window|\s+length)?\s+(?:is\s+)?(?:too\s+long|overflow|exceed|limit)/i.test(message) ||
    /maximum context length|prompt is too long|token limit/i.test(message)
  );
}

function readStatus(value: Record<string, unknown> | undefined): number | undefined {
  const status = value?.status ?? value?.statusCode;
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined;
}

/**
 * 当请求了一个尚未实现的 Provider 时抛出。
 * 例如 `azure` / `bedrock` 在当前构建中未提供真实传输层。
 */
export class ProviderNotImplementedError extends Error {
  public readonly provider: string;

  constructor(provider: string, message?: string) {
    super(
      message ??
        `Provider '${provider}' is not implemented in this build. Configure a supported provider or implement a transport.`
    );
    this.name = 'ProviderNotImplementedError';
    this.provider = provider;
  }
}
