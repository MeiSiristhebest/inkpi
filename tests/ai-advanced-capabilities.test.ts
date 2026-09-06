import {
  calculateDynamicModelCost,
  clearCostCache,
  generateImage,
  getOAuthAuthorizeUrl,
  openAiCompatibleImageProvider,
  registerModelCost,
  signAwsRequest
} from '@inkpi/ai';
import { describe, expect, it, vi } from 'vitest';

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
    });

    it('should fallback gracefully when model not registered in catalog', () => {
      clearCostCache();
      const cost = calculateDynamicModelCost(
        'unregistered-model',
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        { inputPerMillionUsd: 1.0, outputPerMillionUsd: 2.0 }
      );
      expect(cost.totalCostUsd).toBeCloseTo(3.0, 4);
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
  });
});
