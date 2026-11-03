import { describe, expect, it, vi } from 'vitest';
import { probeModelProvider } from './model-provider-probe.js';

describe('Runtime model provider probe', () => {
  it('lists OpenAI-compatible models without exposing credentials in the response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'model-a',
                name: 'Model A',
                context_window: 64_000,
                max_output_tokens: 4_096,
                input_modalities: ['text', 'image'],
                input_cost_per_token: '0.000001',
                output_cost_per_token: '0.000002'
              },
              { id: 'model-b' }
            ]
          }),
          { status: 200 }
        )
    );
    const times = [100, 137];

    const result = await probeModelProvider(
      {
        provider: 'custom',
        baseUrl: 'https://models.example.test/v1/',
        credentialRef: 'inkpi.model.custom.model-a'
      },
      {
        fetchImpl,
        now: () => times.shift() ?? 137,
        resolveCredential: async (reference) => {
          expect(reference).toBe('inkpi.model.custom.model-a');
          return 'secret';
        }
      }
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
      modelIds: ['model-a', 'model-b'],
      catalogModels: [
        {
          id: 'model-a',
          name: 'Model A',
          contextTokens: 64_000,
          maxOutputTokens: 4_096,
          inputModalities: ['text', 'image'],
          promptPricePerToken: '0.000001',
          completionPricePerToken: '0.000002'
        },
        { id: 'model-b' }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('uses provider-native authentication and paths for Anthropic, Google, and Ollama', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }));

    await probeModelProvider(
      {
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        credentialRef: 'inkpi.model.anthropic.claude'
      },
      { fetchImpl, resolveCredential: async () => 'anthropic-secret' }
    );
    await probeModelProvider(
      {
        provider: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        credentialRef: 'inkpi.model.google.gemini'
      },
      { fetchImpl, resolveCredential: async () => 'google-secret' }
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
    await expect(probeModelProvider({ provider: 'custom', baseUrl: 'not a URL' }, { fetchImpl })).rejects.toThrow(
      'valid HTTP(S) URL'
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses Azure Responses authentication and never probes Codex account tokens generically', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ data: [{ id: 'deployment-a' }] }), { status: 200 })
    );
    const result = await probeModelProvider(
      {
        provider: 'azure-openai-responses',
        baseUrl: 'https://resource.openai.azure.com/openai/v1',
        credentialRef: 'inkpi.model.azure.deployment-a'
      },
      { fetchImpl, resolveCredential: async () => 'azure-secret' }
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://resource.openai.azure.com/openai/v1/models',
      expect.objectContaining({ headers: { Accept: 'application/json', 'api-key': 'azure-secret' } })
    );
    expect(result.modelIds).toEqual(['deployment-a']);

    const resolveCredential = vi.fn(async () => 'codex-token');
    await expect(
      probeModelProvider(
        {
          provider: 'openai-codex',
          baseUrl: 'https://chatgpt.com/backend-api',
          credentialRef: 'inkpi.model.openai-codex.account.ref'
        },
        { fetchImpl, resolveCredential }
      )
    ).rejects.toThrow('cannot be used for generic provider discovery');
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('routes ChatGPT plan probes through the account API instead of API-key authentication', async () => {
    const fetchImpl = vi.fn();
    await expect(
      probeModelProvider({ provider: 'openai-chatgpt-plan', baseUrl: 'https://api.openai.com/v1' }, { fetchImpl })
    ).rejects.toThrow('through the account Runtime API');
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
