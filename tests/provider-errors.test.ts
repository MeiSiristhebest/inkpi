import {
  ProviderError,
  ProviderNotImplementedError,
  classifyProviderError,
  deepSeekProvider,
  providerHttpError,
  retryAssistantStream
} from '@inkpi/ai';
import { describe, expect, it, vi } from 'vitest';

describe('provider error taxonomy', () => {
  it('classifies HTTP failures into stable retry categories', () => {
    expect(providerHttpError('openai', 401, 'Unauthorized')).toMatchObject({
      code: 'authentication',
      retryable: false,
      provider: 'openai',
      status: 401
    });
    expect(providerHttpError('openai', 429, 'Too Many Requests')).toMatchObject({
      code: 'rate_limit',
      retryable: true,
      status: 429
    });
    expect(providerHttpError('openai', 503, 'Service Unavailable')).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      status: 503
    });
    expect(providerHttpError('openai', 400, 'Bad Request')).toMatchObject({
      code: 'invalid_request',
      retryable: false,
      status: 400
    });
  });

  it('classifies local transport, cancellation, malformed response, and capability failures', () => {
    expect(classifyProviderError(new TypeError('Failed to fetch'))).toMatchObject({
      code: 'transient_transport',
      retryable: true
    });
    expect(classifyProviderError({ name: 'AbortError', message: 'Aborted' })).toMatchObject({
      code: 'cancelled',
      retryable: false
    });
    expect(classifyProviderError(new Error('Malformed Gemini stream event'))).toMatchObject({
      code: 'malformed_response',
      retryable: false
    });
    expect(classifyProviderError(new ProviderNotImplementedError('bedrock'))).toMatchObject({
      code: 'unsupported_capability',
      retryable: false,
      provider: 'bedrock'
    });
  });

  it('carries HTTP taxonomy metadata through a provider stream', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized'
    }) as any;

    try {
      const stream = deepSeekProvider(
        { id: 'deepseek-chat', name: 'DeepSeek', provider: 'deepseek', apiKey: 'invalid' },
        [{ role: 'user', content: 'hello' }]
      );
      const events: Array<{ type: string; code?: string; retryable?: boolean }> = [];
      stream.on((event) => {
        if (event.type === 'error') events.push(event);
      });

      await expect(stream.collect()).resolves.toMatchObject({ stopReason: 'error' });
      expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'authentication', retryable: false })]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not retry normalized non-retryable provider failures', async () => {
    let attempts = 0;
    await expect(
      retryAssistantStream(
        async () => {
          attempts += 1;
          throw new ProviderError({ code: 'authentication', message: 'invalid credential', provider: 'openai' });
        },
        { maxRetries: 3, initialDelayMs: 1 }
      )
    ).rejects.toThrow('invalid credential');
    expect(attempts).toBe(1);
  });

  it('preserves an already-normalized ProviderError', () => {
    const error = new ProviderError({
      code: 'policy_refusal',
      message: 'Provider refused the request.',
      provider: 'custom'
    });
    expect(classifyProviderError(error)).toBe(error);
  });
});
