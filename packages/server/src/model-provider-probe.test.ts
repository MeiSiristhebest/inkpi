import { describe, expect, it, vi } from 'vitest';
import { probeModelProvider } from './model-provider-probe.js';

describe('Runtime model provider probe', () => {
  it('lists OpenAI-compatible models without exposing credentials in the response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
          status: 200
        })
    );
    const times = [100, 137];

    const result = await probeModelProvider(
      {
        provider: 'custom',
        baseUrl: 'https://models.example.test/v1/',
        apiKey: 'secret'
      },
      { fetchImpl, now: () => times.shift() ?? 137 }
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://models.example.test/v1/models',
      expect.objectContaining({
        redirect: 'error',
        headers: { Accept: 'application/json', Authorization: 'Bearer secret' }
      })
    );
    expect(result).toEqual({
      status: 200,
      latency: 37,
      modelIds: ['model-a', 'model-b']
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('uses provider-native authentication and paths for Anthropic, Google, and Ollama', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }));

    await probeModelProvider(
      {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'anthropic-secret'
      },
      { fetchImpl }
    );
    await probeModelProvider(
      {
        provider: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'google-secret'
      },
      { fetchImpl }
    );
    await probeModelProvider({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }, { fetchImpl });

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.anthropic.com/v1/models',
      'https://generativelanguage.googleapis.com/v1beta/models',
      'http://127.0.0.1:11434/api/tags'
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        'x-api-key': 'anthropic-secret',
        'anthropic-version': '2023-06-01'
      }
    });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      headers: { 'x-goog-api-key': 'google-secret' }
    });
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({
      headers: { Accept: 'application/json' }
    });
  });

  it('rejects URLs that could carry credentials or non-HTTP schemes', async () => {
    const fetchImpl = vi.fn();

    await expect(
      probeModelProvider({ provider: 'custom', baseUrl: 'file:///tmp/models' }, { fetchImpl })
    ).rejects.toThrow('HTTP or HTTPS');
    await expect(
      probeModelProvider({ provider: 'custom', baseUrl: 'https://user:pass@example.test' }, { fetchImpl })
    ).rejects.toThrow('must not contain credentials');
    await expect(
      probeModelProvider({ provider: 'custom', baseUrl: 'https://example.test?key=secret' }, { fetchImpl })
    ).rejects.toThrow('must not contain credentials');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns reachable HTTP failures without attempting to parse model data', async () => {
    const json = vi.fn();
    const fetchImpl = vi.fn(async () => ({ status: 401, ok: false, json }) as unknown as Response);

    const result = await probeModelProvider({ provider: 'openai', baseUrl: 'https://api.example.test' }, { fetchImpl });

    expect(result).toMatchObject({ status: 401, modelIds: [] });
    expect(json).not.toHaveBeenCalled();
  });
});
