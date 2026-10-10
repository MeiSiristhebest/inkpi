import { createHash } from 'node:crypto';
import { createServer, get as httpGet } from 'node:http';
import {
  calculateDynamicModelCost,
  clearCostCache,
  generateImage,
  getOAuthAuthorizeUrl,
  openAiCompatibleImageProvider,
  refreshCatalog,
  refreshOAuthToken,
  registerModelCost,
  signAwsRequest,
  startOAuthLoginFlow
} from '@inkpi/ai';
import { describe, expect, it, vi } from 'vitest';

function requestLoopbackCallback(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpGet(url, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    }).on('error', reject);
  });
}

describe('@inkpi/ai: Dynamic Cost, Images, AWS SigV4, Local OAuth', () => {
  describe('1. Dynamic Cost Calculator (Zero Hardcoding)', () => {
    it('should calculate cost accurately based on dynamic catalog entry', () => {
      registerModelCost({
        id: 'test-cost-model',
        name: 'Test Cost Model',
        provider: 'openai',
        contextWindow: 128000,
        maxTokens: 4096,
        supportsThinking: false,
        supportsTools: true,
        cost: {
          inputPerMillionUsd: 2.5, // $2.5 / M
          outputPerMillionUsd: 10.0, // $10 / M
          cacheReadPerMillionUsd: 0.5,
          cacheWritePerMillionUsd: 3.0
        }
      });

      const cost = calculateDynamicModelCost('test-cost-model', {
        inputTokens: 100_000, // 0.1M -> $0.25
        outputTokens: 50_000, // 0.05M -> $0.50
        cacheReadTokens: 200_000, // 0.2M -> $0.10
        cacheWriteTokens: 100_000 // 0.1M -> $0.30
      });

      expect(cost.inputCostUsd).toBeCloseTo(0.25, 4);
      expect(cost.outputCostUsd).toBeCloseTo(0.5, 4);
      expect(cost.cacheReadCostUsd).toBeCloseTo(0.1, 4);
      expect(cost.cacheWriteCostUsd).toBeCloseTo(0.3, 4);
      expect(cost.totalCostUsd).toBeCloseTo(1.15, 4);
      expect(cost.status).toBe('known');
    });

    it('should fallback gracefully when model not registered in catalog', () => {
      clearCostCache();
      const cost = calculateDynamicModelCost(
        'unregistered-model',
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        { inputPerMillionUsd: 1.0, outputPerMillionUsd: 2.0 }
      );
      expect(cost.totalCostUsd).toBeCloseTo(3.0, 4);
      expect(cost.status).toBe('known');
    });

    it('marks missing and incomplete prices as unknown instead of reporting zero cost', () => {
      const missing = calculateDynamicModelCost('unregistered-model', { inputTokens: 100, outputTokens: 20 });
      expect(missing).toMatchObject({ status: 'unknown', totalCostUsd: null, inputCostUsd: null });

      registerModelCost({
        id: 'partial-cost-model',
        name: 'Partial Cost Model',
        provider: 'openai',
        contextWindow: 128000,
        maxTokens: 4096,
        supportsThinking: false,
        supportsTools: true,
        cost: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 }
      });
      const partial = calculateDynamicModelCost('partial-cost-model', {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 500
      });
      expect(partial.status).toBe('partial');
      expect(partial.cacheReadCostUsd).toBeNull();
      expect(partial.totalCostUsd).toBeNull();
    });

    it('uses provider service tier, prompt length, and cache-write duration rates', () => {
      registerModelCost({
        id: 'tiered-cost-model',
        name: 'Tiered Cost Model',
        provider: 'openai',
        contextWindow: 1_000_000,
        maxTokens: 16_000,
        supportsThinking: false,
        supportsTools: true,
        cost: {
          inputPerMillionUsd: 1,
          outputPerMillionUsd: 2,
          cacheReadPerMillionUsd: 0.5,
          cacheWritePerMillionUsd: 1,
          serviceTierRates: { priority: { inputPerMillionUsd: 2, outputPerMillionUsd: 3 } },
          promptLengthTiers: [
            { minimumPromptTokens: 100_000, rates: { inputPerMillionUsd: 4, outputPerMillionUsd: 5 } }
          ],
          cacheWritePerMillionUsdByTtl: { '5m': 3, '1h': 6 }
        }
      });

      const cost = calculateDynamicModelCost('tiered-cost-model', {
        inputTokens: 100_000,
        outputTokens: 50_000,
        promptTokens: 100_000,
        serviceTier: 'priority',
        cacheReadTokens: 10_000,
        cacheWriteTokens: 40_000,
        cacheWrite5mTokens: 20_000,
        cacheWrite1hTokens: 20_000
      });
      expect(cost).toMatchObject({ status: 'known' });
      expect(cost.inputCostUsd).toBeCloseTo(0.4, 6);
      expect(cost.outputCostUsd).toBeCloseTo(0.25, 6);
      expect(cost.cacheReadCostUsd).toBeCloseTo(0.005, 6);
      expect(cost.cacheWriteCostUsd).toBeCloseTo(0.18, 6);
      expect(cost.totalCostUsd).toBeCloseTo(0.835, 6);

      const unknownDuration = calculateDynamicModelCost('tiered-cost-model', {
        inputTokens: 1,
        outputTokens: 1,
        promptTokens: 1,
        serviceTier: 'priority',
        cacheWriteTokens: 100
      });
      expect(unknownDuration.status).toBe('partial');
      expect(unknownDuration.cacheWriteCostUsd).toBeNull();
      expect(unknownDuration.totalCostUsd).toBeNull();
    });

    it('sends ETag conditionals and replaces withdrawn remote entries only in authoritative mode', async () => {
      clearCostCache();
      const originalFetch = globalThis.fetch;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              {
                id: 'remote-old',
                name: 'Old remote model',
                provider: 'openai',
                contextWindow: 1000,
                maxTokens: 100,
                supportsThinking: false,
                supportsTools: false,
                cost: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 }
              }
            ]),
            { status: 200, headers: { ETag: '"catalog-v1"' } }
          )
        )
        .mockResolvedValueOnce(new Response(null, { status: 304, headers: { ETag: '"catalog-v1"' } }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              {
                id: 'remote-current',
                name: 'Current remote model',
                provider: 'openai',
                contextWindow: 1000,
                maxTokens: 100,
                supportsThinking: false,
                supportsTools: false,
                cost: { inputPerMillionUsd: 3, outputPerMillionUsd: 4 }
              }
            ]),
            { status: 200, headers: { ETag: '"catalog-v2"' } }
          )
        );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        const options = { url: 'https://catalog.example/models', cacheTtlMs: 0 };
        expect(await refreshCatalog(options)).toBe(1);
        expect(await refreshCatalog(options)).toBe(1);
        expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({ 'If-None-Match': '"catalog-v1"' });

        expect(await refreshCatalog({ ...options, mode: 'replace' })).toBe(1);
        expect(calculateDynamicModelCost('remote-old', { inputTokens: 1, outputTokens: 1 }).status).toBe('unknown');
        expect(calculateDynamicModelCost('remote-current', { inputTokens: 1, outputTokens: 1 })).toMatchObject({
          status: 'known',
          totalCostUsd: 0.000007
        });
      } finally {
        globalThis.fetch = originalFetch;
        clearCostCache();
      }
    });

    it('does not publish a stale remote refresh after a newer response', async () => {
      clearCostCache();
      const originalFetch = globalThis.fetch;
      let resolveFirst!: (response: Response) => void;
      const firstResponse = new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => firstResponse)
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([
              {
                id: 'newer-remote',
                name: 'Newer',
                provider: 'openai',
                contextWindow: 1000,
                maxTokens: 100,
                supportsThinking: false,
                supportsTools: false,
                cost: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 }
              }
            ]),
            { status: 200 }
          )
        );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        const options = { url: 'https://catalog.example/concurrent', cacheTtlMs: 0, mode: 'replace' as const };
        const firstRefresh = refreshCatalog(options);
        const secondRefresh = refreshCatalog(options);
        await secondRefresh;
        resolveFirst(
          new Response(
            JSON.stringify([
              {
                id: 'older-remote',
                name: 'Older',
                provider: 'openai',
                contextWindow: 1000,
                maxTokens: 100,
                supportsThinking: false,
                supportsTools: false,
                cost: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 }
              }
            ]),
            { status: 200 }
          )
        );
        await firstRefresh;

        expect(calculateDynamicModelCost('newer-remote', { inputTokens: 1, outputTokens: 1 }).status).toBe('known');
        expect(calculateDynamicModelCost('older-remote', { inputTokens: 1, outputTokens: 1 }).status).toBe('unknown');
      } finally {
        globalThis.fetch = originalFetch;
        clearCostCache();
      }
    });
  });

  describe('2. Image Generation (Book Cover & Illustrations)', () => {
    it('should generate images via standard endpoint with proper payload', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          created: 1740000000,
          data: [
            {
              url: 'https://images.cdn.test/cover-design-1.png',
              revised_prompt: 'A majestic mountain landscape cover'
            }
          ]
        })
      });
      globalThis.fetch = fetchMock as any;

      try {
        const result = await generateImage({
          prompt: 'A majestic mountain landscape cover',
          model: 'dall-e-3',
          size: '1024x1792', // 竖版书封面
          quality: 'hd',
          style: 'natural',
          apiKey: 'test-img-key'
        });

        expect(result.data.length).toBe(1);
        expect(result.data[0].url).toBe('https://images.cdn.test/cover-design-1.png');

        const callArgs = fetchMock.mock.calls[0];
        expect(callArgs[0]).toBe('https://api.openai.com/v1/images/generations');
        const body = JSON.parse(callArgs[1].body);
        expect(body.prompt).toBe('A majestic mountain landscape cover');
        expect(body.size).toBe('1024x1792');
        expect(body.quality).toBe('hd');
        expect(body.style).toBe('natural');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('should throw when image provider is not registered or API key is missing', async () => {
      await expect(generateImage({ prompt: 'test' }, 'unknown-provider')).rejects.toThrow(
        "Image provider 'unknown-provider' is not registered."
      );

      const prevEnv = process.env.OPENAI_API_KEY;
      const prevImgEnv = process.env.IMAGE_API_KEY;
      process.env.OPENAI_API_KEY = '';
      process.env.IMAGE_API_KEY = '';
      try {
        await expect(openAiCompatibleImageProvider({ prompt: 'test' })).rejects.toThrow(
          'Missing API key for image generation'
        );
      } finally {
        process.env.OPENAI_API_KEY = prevEnv;
        process.env.IMAGE_API_KEY = prevImgEnv;
      }
    });
  });

  describe('3. AWS SigV4 Zero-Dependency Signer', () => {
    it('should produce standard AWS4-HMAC-SHA256 signature headers without AWS SDK', async () => {
      const headers = await signAwsRequest({
        method: 'POST',
        url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-3-5-sonnet/converse',
        body: JSON.stringify({ message: 'hello' }),
        region: 'us-east-1',
        service: 'bedrock',
        datetime: '20260905T120000Z',
        credentials: {
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
        }
      });

      expect(headers.host).toBe('bedrock-runtime.us-east-1.amazonaws.com');
      expect(headers['x-amz-date']).toBe('20260905T120000Z');
      expect(headers.Authorization).toContain(
        'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260905/us-east-1/bedrock/aws4_request'
      );
      expect(headers.Authorization).toContain('SignedHeaders=');
      expect(headers.Authorization).toContain('Signature=');
    });

    it('should throw descriptive error on invalid URL', async () => {
      await expect(
        signAwsRequest({
          method: 'GET',
          url: 'invalid-url',
          region: 'us-east-1',
          service: 'bedrock',
          credentials: { accessKeyId: 'k', secretAccessKey: 's' }
        })
      ).rejects.toThrow("Invalid URL for AWS signing: 'invalid-url'");
    });
  });

  describe('4. Local OAuth Flow Client', () => {
    it('should build authorize URL with parameters correctly', () => {
      const authUrl = getOAuthAuthorizeUrl(
        {
          clientId: 'client-123',
          authorizationUrl: 'https://github.com/login/oauth/authorize',
          tokenUrl: 'https://github.com/login/oauth/access_token',
          scopes: ['read:user', 'copilot']
        },
        'http://localhost:18420/oauth/callback',
        'random-state-token'
      );

      const parsed = new URL(authUrl);
      expect(parsed.origin).toBe('https://github.com');
      expect(parsed.searchParams.get('client_id')).toBe('client-123');
      expect(parsed.searchParams.get('scope')).toBe('read:user copilot');
      expect(parsed.searchParams.get('state')).toBe('random-state-token');
      expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:18420/oauth/callback');
    });

    it('should throw on invalid authorizationUrl', () => {
      expect(() =>
        getOAuthAuthorizeUrl(
          {
            clientId: 'id',
            authorizationUrl: 'not a url',
            tokenUrl: 'https://test/token',
            scopes: []
          },
          'http://localhost',
          'state'
        )
      ).toThrow("Invalid authorizationUrl: 'not a url'");
    });

    it('uses PKCE, binds an ephemeral loopback port, and persists tokens before resolving', async () => {
      const originalFetch = globalThis.fetch;
      let exchangeBody: URLSearchParams | undefined;
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        exchangeBody = new URLSearchParams(String(init?.body ?? ''));
        return new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'rotated-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      let callbackResponse: Promise<number> | undefined;
      let authorizationChallenge: string | null = null;
      let persisted: unknown;

      try {
        const flow = startOAuthLoginFlow(
          {
            clientId: 'client-123',
            authorizationUrl: 'https://identity.example/authorize',
            tokenUrl: 'https://identity.example/token',
            scopes: ['profile'],
            port: 0,
            onToken: (tokens) => {
              persisted = tokens;
            }
          },
          (authUrl) => {
            const authorization = new URL(authUrl);
            expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
            authorizationChallenge = authorization.searchParams.get('code_challenge');
            const redirectUri = authorization.searchParams.get('redirect_uri')!;
            expect(new URL(redirectUri).port).not.toBe('0');
            callbackResponse = requestLoopbackCallback(
              `${redirectUri}?code=authorization-code&state=${encodeURIComponent(authorization.searchParams.get('state')!)}`
            );
          }
        );

        const tokens = await flow;
        expect(await callbackResponse).toBe(200);
        expect(tokens).toMatchObject({ accessToken: 'access-token', refreshToken: 'rotated-refresh-token' });
        expect(persisted).toEqual(tokens);
        const verifier = exchangeBody?.get('code_verifier');
        expect(verifier).toBeTruthy();
        expect(exchangeBody?.get('grant_type')).toBe('authorization_code');
        expect(new URL(fetchMock.mock.calls[0][0] as string).href).toBe('https://identity.example/token');
        expect(authorizationChallenge).toBe(createHash('sha256').update(verifier!).digest('base64url'));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('retains an existing refresh token when the provider omits a replacement', async () => {
      const originalFetch = globalThis.fetch;
      let requestBody: URLSearchParams | undefined;
      globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
        requestBody = new URLSearchParams(String(init?.body ?? ''));
        return new Response(JSON.stringify({ access_token: 'new-access-token', expires_in: 600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }) as unknown as typeof fetch;
      let persisted: unknown;

      try {
        const tokens = await refreshOAuthToken({
          clientId: 'client-123',
          tokenUrl: 'https://identity.example/token',
          refreshToken: 'existing-refresh-token',
          onToken: (value) => {
            persisted = value;
          }
        });

        expect(requestBody?.get('grant_type')).toBe('refresh_token');
        expect(requestBody?.get('refresh_token')).toBe('existing-refresh-token');
        expect(tokens.refreshToken).toBe('existing-refresh-token');
        expect(persisted).toEqual(tokens);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('persists a rotated refresh token after the caller cancels its wait', async () => {
      const originalFetch = globalThis.fetch;
      const controller = new AbortController();
      let resolveFetch!: (response: Response) => void;
      let tokenFetchSignal: AbortSignal | null | undefined;
      const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
        tokenFetchSignal = init?.signal;
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const persisted = vi.fn();

      try {
        const refresh = refreshOAuthToken({
          clientId: 'client-123',
          tokenUrl: 'https://identity.example/token',
          refreshToken: 'existing-refresh-token',
          signal: controller.signal,
          onToken: persisted
        });

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(tokenFetchSignal).not.toBe(controller.signal);
        controller.abort();
        await expect(refresh).rejects.toMatchObject({ name: 'AbortError' });
        expect(tokenFetchSignal?.aborted).toBe(false);

        resolveFetch(
          new Response(JSON.stringify({ access_token: 'new-access-token', refresh_token: 'rotated-refresh-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        );
        await vi.waitFor(() => expect(persisted).toHaveBeenCalledOnce());
        expect(persisted).toHaveBeenCalledWith({
          accessToken: 'new-access-token',
          refreshToken: 'rotated-refresh-token'
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('coalesces concurrent refreshes and persists the result for every caller', async () => {
      const originalFetch = globalThis.fetch;
      let resolveFetch!: (response: Response) => void;
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const persistFirst = vi.fn();
      const persistSecond = vi.fn();

      try {
        const options = {
          clientId: 'client-123',
          tokenUrl: 'https://identity.example/token',
          refreshToken: 'existing-refresh-token'
        };
        const first = refreshOAuthToken({ ...options, onToken: persistFirst });
        const second = refreshOAuthToken({ ...options, onToken: persistSecond });
        expect(fetchMock).toHaveBeenCalledOnce();

        resolveFetch(
          new Response(JSON.stringify({ access_token: 'new-access-token', refresh_token: 'rotated-refresh-token' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
        );
        await expect(Promise.all([first, second])).resolves.toEqual([
          { accessToken: 'new-access-token', refreshToken: 'rotated-refresh-token' },
          { accessToken: 'new-access-token', refreshToken: 'rotated-refresh-token' }
        ]);
        expect(persistFirst).toHaveBeenCalledOnce();
        expect(persistSecond).toHaveBeenCalledOnce();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('sends the token exchange abort signal and closes on cancellation', async () => {
      const originalFetch = globalThis.fetch;
      const controller = new AbortController();
      let tokenFetchSignal: AbortSignal | null | undefined;
      globalThis.fetch = vi.fn((_url: string, init?: RequestInit) => {
        tokenFetchSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
            once: true
          });
        });
      }) as unknown as typeof fetch;
      let callbackResponse: Promise<number> | undefined;

      try {
        const flow = startOAuthLoginFlow(
          {
            clientId: 'client-123',
            authorizationUrl: 'https://identity.example/authorize',
            tokenUrl: 'https://identity.example/token',
            scopes: [],
            port: 0,
            signal: controller.signal
          },
          (authUrl) => {
            const authorization = new URL(authUrl);
            const redirectUri = authorization.searchParams.get('redirect_uri')!;
            callbackResponse = requestLoopbackCallback(
              `${redirectUri}?code=authorization-code&state=${encodeURIComponent(authorization.searchParams.get('state')!)}`
            );
          }
        );
        await vi.waitFor(() => expect(tokenFetchSignal).toBe(controller.signal));
        controller.abort();
        await expect(flow).rejects.toMatchObject({ name: 'AbortError' });
        expect(await callbackResponse).toBe(503);
      } finally {
        controller.abort();
        globalThis.fetch = originalFetch;
      }
    });

    it('rejects provider cancellation without attempting token exchange', async () => {
      const originalFetch = globalThis.fetch;
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      let callbackResponse: Promise<number> | undefined;

      try {
        const flow = startOAuthLoginFlow(
          {
            clientId: 'client-123',
            authorizationUrl: 'https://identity.example/authorize',
            tokenUrl: 'https://identity.example/token',
            scopes: [],
            port: 0
          },
          (authUrl) => {
            const authorization = new URL(authUrl);
            const redirectUri = authorization.searchParams.get('redirect_uri')!;
            callbackResponse = requestLoopbackCallback(
              `${redirectUri}?error=access_denied&state=${encodeURIComponent(authorization.searchParams.get('state')!)}`
            );
          }
        );

        await expect(flow).rejects.toThrow('OAuth authorization failed: access_denied');
        expect(await callbackResponse).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('rejects a port conflict instead of leaving the login flow pending', async () => {
      const occupied = createServer();
      await new Promise<void>((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', resolve);
      });
      const address = occupied.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');

      try {
        await expect(
          startOAuthLoginFlow({
            clientId: 'client-123',
            authorizationUrl: 'https://identity.example/authorize',
            tokenUrl: 'https://identity.example/token',
            scopes: [],
            port: address.port
          })
        ).rejects.toMatchObject({ code: 'EADDRINUSE' });
      } finally {
        await new Promise<void>((resolve, reject) => occupied.close((error) => (error ? reject(error) : resolve())));
      }
    });
  });
});
