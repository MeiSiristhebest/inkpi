import { streamAi } from '@inkpi/ai';
import { describe, expect, it, vi } from 'vitest';

const userMessages = [{ role: 'user' as const, content: 'Continue the draft.' }];

function anthropicResponse(): Response {
  return new Response(
    [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n',
      'data: {"type":"message_stop"}\n\n'
    ].join(''),
    { status: 200 }
  );
}

function openAiResponse(): Response {
  return new Response(
    [
      'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      'data: [DONE]\n\n'
    ].join(''),
    { status: 200 }
  );
}

async function withFetchMock<T>(
  response: Response,
  run: (fetchMock: ReturnType<typeof vi.fn>) => Promise<T>
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.fn().mockResolvedValue(response);
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  try {
    return await run(fetchMock);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const body = fetchMock.mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request body.');
  return JSON.parse(body) as Record<string, unknown>;
}

describe('provider prompt cache controls', () => {
  it.each(['5m', '1h'] as const)('sends the Anthropic %s TTL on the system prefix', async (ttl) => {
    await withFetchMock(anthropicResponse(), async (fetchMock) => {
      const message = await streamAi(
        {
          id: 'claude-cache-test',
          name: 'Claude cache test',
          provider: 'claude',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'test-key',
          supportsPromptCache: true
        },
        userMessages,
        { systemPrompt: 'Stable system prefix.', cacheControl: { type: 'ephemeral', ttl } }
      ).collect();

      expect(message.stopReason).toBe('stop');
      const request = requestBody(fetchMock);
      expect(request.system).toEqual([
        {
          type: 'text',
          text: 'Stable system prefix.',
          cache_control: { type: 'ephemeral', ttl }
        }
      ]);
    });
  });

  it.each([false, { type: 'disabled' }] as const)(
    'lets an explicit %s override disable model-level Anthropic caching',
    async (cacheControl) => {
      await withFetchMock(anthropicResponse(), async (fetchMock) => {
        const message = await streamAi(
          {
            id: 'claude-cache-test',
            name: 'Claude cache test',
            provider: 'claude',
            baseUrl: 'https://provider.test/v1',
            apiKey: 'test-key',
            supportsPromptCache: true,
            cacheControl: { type: 'ephemeral', ttl: '1h' }
          },
          userMessages,
          { systemPrompt: 'Stable system prefix.', cacheControl }
        ).collect();

        expect(message.stopReason).toBe('stop');
        const request = requestBody(fetchMock);
        expect(request.system).toEqual([{ type: 'text', text: 'Stable system prefix.' }]);
      });
    }
  );

  it('uses a model-level TTL when the request does not override cache control', async () => {
    await withFetchMock(anthropicResponse(), async (fetchMock) => {
      const message = await streamAi(
        {
          id: 'claude-cache-test',
          name: 'Claude cache test',
          provider: 'claude',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'test-key',
          supportsPromptCache: true,
          cacheControl: { type: 'ephemeral', ttl: '1h' }
        },
        userMessages,
        { systemPrompt: 'Stable system prefix.' }
      ).collect();

      expect(message.stopReason).toBe('stop');
      expect(requestBody(fetchMock).system).toEqual([
        {
          type: 'text',
          text: 'Stable system prefix.',
          cache_control: { type: 'ephemeral', ttl: '1h' }
        }
      ]);
    });
  });

  it('sends the OpenAI 30m TTL with the conversation cache key', async () => {
    await withFetchMock(openAiResponse(), async (fetchMock) => {
      const message = await streamAi(
        {
          id: 'gpt-5.6-cache-test',
          name: 'GPT cache test',
          provider: 'openai',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'test-key',
          supportsPromptCache: true
        },
        userMessages,
        {
          providerSessionId: 'conversation-1',
          systemPrompt: 'Stable system prefix.',
          cacheControl: { type: 'ephemeral', ttl: '30m' }
        }
      ).collect();

      expect(message.stopReason).toBe('stop');
      expect(requestBody(fetchMock)).toMatchObject({
        prompt_cache_key: 'conversation-1',
        prompt_cache_options: { ttl: '30m' }
      });
    });
  });

  it('rejects a TTL the provider does not support before sending a request', async () => {
    await withFetchMock(openAiResponse(), async (fetchMock) => {
      const message = await streamAi(
        {
          id: 'gpt-cache-test',
          name: 'GPT cache test',
          provider: 'openai',
          baseUrl: 'https://provider.test/v1',
          apiKey: 'test-key',
          supportsPromptCache: true
        },
        userMessages,
        { cacheControl: { type: 'ephemeral', ttl: '1h' } }
      ).collect();

      expect(message.stopReason).toBe('error');
      expect(message.errorMessage).toContain("Prompt cache TTL '1h' is not supported");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
