import {
  AssistantEventStream,
  type ModelConfig,
  getProvider,
  registerProvider,
  sanitizeMessagesForProvider,
  streamAi
} from '@inkpi/ai';
import type { AgentMessage, ProviderModelSource } from '@inkpi/protocol';
import { describe, expect, it, vi } from 'vitest';

const targetModel = {
  id: 'claude-current',
  name: 'Claude current',
  provider: 'claude',
  routeId: 'route-current'
} satisfies ModelConfig;

function responseFrom(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      }
    }),
    { status: 200 }
  );
}

function assistantMessage(providerSource?: ProviderModelSource): Extract<AgentMessage, { role: 'assistant' }> {
  return {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'private reasoning', providerSignature: 'opaque-signature' },
      { type: 'text', text: 'visible reply' },
      { type: 'toolCall', id: 'call|1', name: 'lookup', arguments: { query: 'x' } }
    ],
    ...(providerSource ? { providerSource } : {})
  };
}

describe('provider message provenance', () => {
  it('keeps signed thinking only for the exact provider, model, and route', () => {
    const source = {
      provider: 'claude',
      modelId: targetModel.id,
      routeId: targetModel.routeId
    };
    const original = assistantMessage(source);
    const [projected] = sanitizeMessagesForProvider([original], targetModel);

    expect(projected).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'private reasoning', providerSignature: 'opaque-signature' },
        { type: 'text', text: 'visible reply' },
        { type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { query: 'x' } }
      ]
    });
    expect(original.content[0]).toMatchObject({ type: 'thinking', thinking: 'private reasoning' });
  });

  const incompatibleSources: Array<{
    name: string;
    source?: ProviderModelSource;
    target?: ModelConfig;
  }> = [
    {
      name: 'different provider protocol',
      source: { provider: 'openai', modelId: targetModel.id, routeId: targetModel.routeId }
    },
    {
      name: 'different model on the same provider',
      source: { provider: 'claude', modelId: 'claude-previous', routeId: targetModel.routeId }
    },
    {
      name: 'different host route',
      source: { provider: 'claude', modelId: targetModel.id, routeId: 'route-previous' }
    },
    { name: 'unknown legacy source' },
    {
      name: 'unknown custom endpoint route',
      source: { provider: 'claude', modelId: targetModel.id },
      target: { id: targetModel.id, name: targetModel.name, provider: 'claude', baseUrl: 'https://custom.test/v1' }
    }
  ];

  for (const scenario of incompatibleSources) {
    it(`drops signed thinking for ${scenario.name} without changing the transcript`, () => {
      const messages: AgentMessage[] = [
        assistantMessage(scenario.source),
        {
          role: 'toolResult',
          toolCallId: 'call|1',
          toolName: 'lookup',
          content: [{ type: 'text', text: 'tool result' }]
        }
      ];
      const before = structuredClone(messages);
      const projected = sanitizeMessagesForProvider(messages, scenario.target ?? targetModel);

      expect(projected[0]).toMatchObject({
        role: 'assistant',
        content: [
          { type: 'text', text: 'visible reply' },
          { type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { query: 'x' } }
        ]
      });
      expect(projected[1]).toMatchObject({ role: 'toolResult', toolCallId: 'call_1' });
      expect(JSON.stringify(projected)).not.toContain('private reasoning');
      expect(JSON.stringify(projected)).not.toContain('opaque-signature');
      expect(messages).toEqual(before);
    });
  }

  it('drops unsigned thinking even when the source matches', () => {
    const message = assistantMessage({
      provider: 'claude',
      modelId: targetModel.id,
      routeId: targetModel.routeId
    });
    message.content[0] = { type: 'thinking', thinking: 'unsigned reasoning' };

    const [projected] = sanitizeMessagesForProvider([message], targetModel);

    expect(projected).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'visible reply' },
        { type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { query: 'x' } }
      ]
    });
  });

  it('does not serialize compatible signed thinking as plain text for Gemini', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: unknown;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return responseFrom(['data: {"candidates":[{"content":{"parts":[{"text":"done"}]},"finishReason":"STOP"}]}\n\n']);
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      await streamAi(
        {
          id: 'gemini-current',
          name: 'Gemini current',
          provider: 'gemini',
          routeId: 'gemini-route',
          apiKey: 'test-only'
        },
        [
          { role: 'user', content: 'earlier prompt' },
          assistantMessage({ provider: 'gemini', modelId: 'gemini-current', routeId: 'gemini-route' })
        ]
      ).collect();

      const body = JSON.stringify(requestBody);
      expect(body).toContain('visible reply');
      expect(body).toContain('call_1');
      expect(body).not.toContain('private reasoning');
      expect(body).not.toContain('opaque-signature');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('does not send compatible signed thinking on Ollama wire messages', async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: unknown;
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return responseFrom(['{"message":{"content":"done"},"done":true,"prompt_eval_count":1,"eval_count":1}\n']);
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    try {
      await streamAi(
        {
          id: 'ollama-current',
          name: 'Ollama current',
          provider: 'ollama',
          routeId: 'ollama-route',
          baseUrl: 'http://ollama.test'
        },
        [
          { role: 'user', content: 'earlier prompt' },
          assistantMessage({ provider: 'ollama', modelId: 'ollama-current', routeId: 'ollama-route' })
        ]
      ).collect();

      const body = JSON.stringify(requestBody);
      expect(body).toContain('visible reply');
      expect(body).toContain('call_1');
      expect(body).not.toContain('private reasoning');
      expect(body).not.toContain('opaque-signature');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sanitizes custom registered providers at their dispatch boundary', async () => {
    const originalHandler = getProvider('custom');
    const received: AgentMessage[][] = [];
    registerProvider('custom', (_model, messages) => {
      received.push(messages);
      const stream = new AssistantEventStream();
      stream.end();
      return stream;
    });

    try {
      await streamAi({ ...targetModel, provider: 'custom' }, [
        assistantMessage({
          provider: 'claude',
          modelId: targetModel.id,
          routeId: targetModel.routeId
        })
      ]).collect();

      expect(received[0]?.[0]).toMatchObject({
        role: 'assistant',
        content: [
          { type: 'text', text: 'visible reply' },
          { type: 'toolCall', id: 'call_1', name: 'lookup' }
        ]
      });
    } finally {
      registerProvider('custom', originalHandler);
    }
  });
});
