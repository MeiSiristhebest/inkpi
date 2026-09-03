import { type HttpClient, getHttpClient, getProvider, setHttpClient } from '@inkpi/ai';
import type { AgentMessage, AssistantMessageEvent } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

class RecordingHttpClient implements HttpClient {
  public calls: Array<{ url: string; init?: RequestInit }> = [];
  constructor(private readonly build: (url: string, init?: RequestInit) => Response) {}
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ url, init });
    return this.build(url, init);
  }
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    }
  });
  return new Response(stream, { status: 200 });
}

const baseModel = {
  id: 'gpt-test',
  name: 'GPT Test',
  provider: 'openai' as const,
  apiKey: 'test-key'
};

const messages: AgentMessage[] = [{ role: 'user', content: 'hi' }];

describe('@inkpi/ai HttpClient port', () => {
  it('routes the openai-compatible provider through the injected client', async () => {
    const fake = new RecordingHttpClient(() =>
      sseResponse(['data: {"choices":[{"delta":{"content":"hello"}}]}', '', 'data: [DONE]', ''])
    );
    setHttpClient(fake);
    try {
      const events: AssistantMessageEvent[] = [];
      const stream = getProvider('openai')(baseModel, messages);
      stream.on((event) => {
        events.push(event);
      });
      const message = await stream.collect();

      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].url).toContain('/chat/completions');
      const init = fake.calls[0].init as RequestInit;
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string).model).toBe('gpt-test');
      expect(message.content.some((c) => c.type === 'text' && c.text === 'hello')).toBe(true);
      expect(events.some((e) => e.type === 'text_delta' && e.textDelta === 'hello')).toBe(true);
    } finally {
      setHttpClient(null);
    }
  });

  it('default GlobalFetchHttpClient delegates to the global fetch binding', async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    let lastUrl: unknown;
    globalThis.fetch = (async (url: string, _init?: RequestInit) => {
      callCount += 1;
      lastUrl = url;
      return new Response(null, { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      await getHttpClient().fetch('http://example.test/x');
      expect(callCount).toBe(1);
      expect(lastUrl).toBe('http://example.test/x');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
