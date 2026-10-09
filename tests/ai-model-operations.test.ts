import {
  type ImageGenerationOptions,
  ModelCatalogV2,
  type ModelCatalogV2Entry,
  type ModelConfig,
  type StreamOptions,
  createFauxProvider,
  executeModelOperation,
  registerImageProvider
} from '@inkpi/ai';
import type { AgentMessage } from '@inkpi/protocol';
import { describe, expect, it, vi } from 'vitest';

const PROVIDER = 'shared-operation-test-provider';
const API_KEY_ENV = 'INKPI_SHARED_OPERATION_TEST_KEY';

function createCatalog(operations: ModelCatalogV2Entry['operations'] = ['chat', 'classify', 'image']) {
  return new ModelCatalogV2([
    {
      id: 'writer/shared-model',
      canonicalId: 'inkpi/shared-model',
      name: 'Shared operation model',
      provider: PROVIDER,
      route: { provider: PROVIDER, modelId: 'provider-native-model', baseUrl: 'https://api.example.test/v1' },
      authentication: { kind: 'api-key', required: true, envVar: API_KEY_ENV },
      operations,
      contextWindow: 16_000,
      maxTokens: 2048,
      supportsThinking: false,
      supportsTools: false,
      supportsVision: false
    }
  ]);
}

describe('executeModelOperation', () => {
  it('shares catalog route and credentials across chat, classify, and image', async () => {
    vi.stubEnv(API_KEY_ENV, 'test-shared-key');
    const catalog = createCatalog();
    const scriptedProvider = createFauxProvider({
      text: '{"label":"continuity","confidence":0.92}',
      usage: { inputTokens: 11, outputTokens: 4, totalTokens: 15 }
    });
    const provider = vi.fn((model: ModelConfig, messages: AgentMessage[], options?: StreamOptions) =>
      scriptedProvider(model, messages, options)
    );
    catalog.registerHandler(PROVIDER, provider);
    const imageHandler = vi.fn(async (_options: ImageGenerationOptions) => ({
      created: 1,
      data: [{ url: 'https://images.example.test/result.png' }]
    }));
    registerImageProvider(PROVIDER, imageHandler);

    try {
      const chat = await executeModelOperation(catalog, {
        operation: 'chat',
        model: 'writer/shared-model',
        messages: [{ role: 'user', content: 'Check the scene.' }]
      });
      expect((await chat.collect()).stopReason).toBe('stop');

      const classification = await executeModelOperation(catalog, {
        operation: 'classify',
        model: 'inkpi/shared-model',
        text: 'The character is older than established facts allow.',
        candidates: [{ label: 'continuity' }, { label: 'tagging' }]
      });
      expect(classification).toMatchObject({
        label: 'continuity',
        confidence: 0.92,
        canonicalModelId: 'inkpi/shared-model'
      });

      const image = await executeModelOperation(catalog, {
        operation: 'image',
        model: 'inkpi/shared-model',
        options: { prompt: 'A book cover', size: '1024x1536' }
      });
      expect(image.data[0]?.url).toBe('https://images.example.test/result.png');

      expect(provider).toHaveBeenCalledTimes(2);
      for (const [model] of provider.mock.calls) {
        expect(model).toMatchObject({
          id: 'provider-native-model',
          provider: PROVIDER,
          baseUrl: 'https://api.example.test/v1',
          apiKey: 'test-shared-key'
        });
      }
      expect(imageHandler).toHaveBeenCalledWith({
        prompt: 'A book cover',
        size: '1024x1536',
        model: 'provider-native-model',
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'test-shared-key'
      });
      expect(JSON.stringify(catalog.getRoute('inkpi/shared-model'))).not.toContain('test-shared-key');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects an operation before dispatch when the model does not advertise it', async () => {
    const catalog = createCatalog(['chat']);
    const handler = vi.fn();
    catalog.registerHandler(PROVIDER, handler);
    const imageHandler = vi.fn(async (_options: ImageGenerationOptions) => ({ created: 0, data: [] }));
    registerImageProvider(PROVIDER, imageHandler);

    await expect(
      executeModelOperation(catalog, {
        operation: 'image',
        model: 'writer/shared-model',
        options: { prompt: 'A cover' }
      })
    ).rejects.toThrow("does not support the 'image' operation");
    expect(handler).not.toHaveBeenCalled();
    expect(imageHandler).not.toHaveBeenCalled();
  });

  it('rejects a missing required credential before invoking a provider', async () => {
    vi.stubEnv(API_KEY_ENV, '');
    const catalog = createCatalog(['chat']);
    const handler = vi.fn(createFauxProvider({ text: 'unused' }));
    catalog.registerHandler(PROVIDER, handler);

    try {
      await expect(
        executeModelOperation(catalog, {
          operation: 'chat',
          model: 'writer/shared-model',
          messages: []
        })
      ).rejects.toThrow(`Set ${API_KEY_ENV}`);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses a host credential resolver for OAuth-backed routes', async () => {
    const entry = createCatalog(['chat']).getModel('inkpi/shared-model')!;
    const catalog = new ModelCatalogV2([
      { ...entry, authentication: { kind: 'oauth', required: true, credentialRef: 'account:writer' } }
    ]);
    const scriptedProvider = createFauxProvider({ text: 'ok' });
    const handler = vi.fn(scriptedProvider);
    catalog.registerHandler(PROVIDER, handler);
    const credentialResolver = vi.fn(() => 'oauth-access-token');

    const stream = await executeModelOperation(
      catalog,
      { operation: 'chat', model: 'inkpi/shared-model', messages: [] },
      { credentialResolver }
    );
    await stream.collect();

    expect(credentialResolver).toHaveBeenCalledWith({
      canonicalModelId: 'inkpi/shared-model',
      provider: PROVIDER,
      authentication: { kind: 'oauth', required: true, credentialRef: 'account:writer' }
    });
    expect(handler.mock.calls[0]?.[0].apiKey).toBe('oauth-access-token');
  });
});
