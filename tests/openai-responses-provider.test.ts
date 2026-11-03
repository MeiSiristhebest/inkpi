import { setHttpClient, streamAi } from '@inkpi/ai';
import type { ModelConfig } from '@inkpi/ai';
import type { AssistantMessageEvent, ProviderModelSource } from '@inkpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => setHttpClient(null));

function eventStream(events: Array<{ event: string; data: unknown }>): Response {
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function codexAccessToken(accountId = 'codex-account-a'): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })}.signature`;
}

function completedText(text: string, event = 'response.completed') {
  return eventStream([
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', output_index: 0, delta: text } },
    {
      event,
      data: {
        type: event,
        response: {
          output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
          usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 }
        }
      }
    }
  ]);
}

describe('OpenAI Responses routes', () => {
  it('uses the API-key Responses endpoint and forwards per-request reasoning effort', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    setHttpClient({
      fetch: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return completedText('OpenAI response');
      }
    });

    const model: ModelConfig = {
      id: 'gpt-6.1-terra',
      name: 'GPT-6.1 Terra',
      provider: 'openai-responses',
      apiKey: 'openai-secret',
      supportsThinking: true,
      reasoningEffort: 'high',
      maxTokens: 2048
    };
    const message = await streamAi(model, [{ role: 'user', content: 'Hello' }], { reasoningEffort: 'low' }).collect();

    expect(requestUrl).toBe('https://api.openai.com/v1/responses');
    expect(requestInit?.headers).toMatchObject({
      Accept: 'text/event-stream',
      Authorization: 'Bearer openai-secret',
      'Content-Type': 'application/json'
    });
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: 'gpt-6.1-terra',
      reasoning: { effort: 'low', summary: 'auto' },
      max_output_tokens: 2048,
      store: false
    });
    expect(message.content).toEqual([{ type: 'text', text: 'OpenAI response' }]);

    await streamAi(model, [{ role: 'user', content: 'Continue' }], { reasoningEffort: 'max' }).collect();
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({ reasoning: { effort: 'xhigh', summary: 'auto' } });
  });

  it('uses Azure resource deployment URLs and the api-key header', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    setHttpClient({
      fetch: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return completedText('Azure response');
      }
    });

    const model: ModelConfig = {
      id: 'terra-deployment',
      name: 'GPT-6.1 Terra deployment',
      provider: 'azure-openai-responses',
      baseUrl: 'https://inkpi-resource.openai.azure.com/openai/v1',
      apiKey: 'azure-secret'
    };
    await streamAi(model, [{ role: 'user', content: 'Hello' }]).collect();

    expect(requestUrl).toBe('https://inkpi-resource.openai.azure.com/openai/v1/responses');
    expect(requestInit?.headers).toMatchObject({
      Accept: 'text/event-stream',
      'api-key': 'azure-secret',
      'Content-Type': 'application/json'
    });
    expect(requestInit?.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({ model: 'terra-deployment', store: false });
  });

  it('pins Codex OAuth tokens to the official endpoint and replays only signed reasoning from the same route', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    setHttpClient({
      fetch: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return eventStream([
          {
            event: 'response.reasoning_summary_text.delta',
            data: { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'brief summary' }
          },
          {
            event: 'response.output_item.done',
            data: {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                id: 'reason-1',
                type: 'reasoning',
                summary: [{ type: 'summary_text', text: 'brief summary' }],
                encrypted_content: 'opaque-codex-reasoning'
              }
            }
          },
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', output_index: 1, delta: 'Codex response' }
          },
          {
            event: 'response.done',
            data: {
              type: 'response.done',
              response: {
                output: [
                  {
                    id: 'reason-1',
                    type: 'reasoning',
                    summary: [{ type: 'summary_text', text: 'brief summary' }],
                    encrypted_content: 'opaque-codex-reasoning'
                  },
                  { type: 'message', content: [{ type: 'output_text', text: 'Codex response' }] }
                ],
                usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
              }
            }
          }
        ]);
      }
    });

    const routeId = 'codex-account-route';
    const model: ModelConfig = {
      id: 'gpt-6.1-terra',
      name: 'GPT-6.1 Terra',
      provider: 'openai-codex',
      routeId,
      baseUrl: 'https://chatgpt.com/backend-api',
      apiKey: codexAccessToken(),
      supportsThinking: true,
      reasoningEffort: 'none'
    };
    const message = await streamAi(model, [{ role: 'user', content: 'Hello' }], {
      systemPrompt: 'Answer directly.',
      providerSessionId: 'conversation-1',
      tools: [
        {
          name: 'tool_search',
          description: 'Search locally registered deferred tools.',
          parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }
        }
      ]
    }).collect();

    expect(requestUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(requestInit?.headers).toMatchObject({
      Authorization: `Bearer ${model.apiKey}`,
      'chatgpt-account-id': 'codex-account-a',
      originator: 'inkpi',
      'OpenAI-Beta': 'responses=experimental',
      'session-id': 'conversation-1'
    });
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: 'gpt-6.1-terra',
      instructions: 'Answer directly.',
      input: [{ role: 'user', content: 'Hello' }],
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'none' },
      tools: [
        {
          type: 'function',
          name: 'tool_search',
          description: 'Search locally registered deferred tools.',
          parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } }
        }
      ]
    });
    expect(message.content).toEqual([
      {
        type: 'thinking',
        thinking: 'brief summary',
        providerBlockIndex: 0,
        providerSignature: 'opaque-codex-reasoning'
      },
      { type: 'text', text: 'Codex response' }
    ]);

    const sameRouteModel = { ...model, apiKey: codexAccessToken(), routeId };
    setHttpClient({
      fetch: async (_url, init) => {
        requestInit = init;
        return completedText('Next response', 'response.done');
      }
    });
    const historicalAssistant = {
      ...message,
      providerSource: { provider: 'openai-codex', modelId: model.id, routeId } satisfies ProviderModelSource
    };
    await streamAi(sameRouteModel, [historicalAssistant]).collect();
    const replayBody = JSON.parse(String(requestInit?.body)) as { input: unknown[] };
    expect(replayBody.input).toContainEqual({ type: 'reasoning', encrypted_content: 'opaque-codex-reasoning' });

    const differentRouteModel = { ...sameRouteModel, routeId: 'another-account-route' };
    await streamAi(differentRouteModel, [historicalAssistant]).collect();
    const sanitizedBody = JSON.parse(String(requestInit?.body)) as { input: unknown[] };
    expect(sanitizedBody.input).not.toContainEqual({ type: 'reasoning', encrypted_content: 'opaque-codex-reasoning' });
  });

  it('rejects non-official Codex endpoints before transmitting an OAuth token', async () => {
    const fetchImpl = async () => {
      throw new Error('Codex token must not be sent to this host');
    };
    setHttpClient({ fetch: fetchImpl });
    const model: ModelConfig = {
      id: 'gpt-6.1-terra',
      name: 'GPT-6.1 Terra',
      provider: 'openai-codex',
      baseUrl: 'https://attacker.example/codex',
      apiKey: codexAccessToken()
    };

    const events: AssistantMessageEvent[] = [];
    const stream = streamAi(model, [{ role: 'user', content: 'Hello' }]);
    for await (const event of stream) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'invalid_request' }));
  });

  it('parses tool arguments from many large deltas without losing the final JSON value', async () => {
    const payload = 'x'.repeat(256 * 1024);
    const argumentsJson = JSON.stringify({ payload });
    const events: Array<{ event: string; data: unknown }> = [
      {
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'function-item', type: 'function_call', call_id: 'large-call', name: 'store', arguments: '' }
        }
      }
    ];
    for (let offset = 0; offset < argumentsJson.length; offset += 1024) {
      events.push({
        event: 'response.function_call_arguments.delta',
        data: {
          type: 'response.function_call_arguments.delta',
          item_id: 'function-item',
          delta: argumentsJson.slice(offset, offset + 1024)
        }
      });
    }
    events.push({
      event: 'response.function_call_arguments.done',
      data: { type: 'response.function_call_arguments.done', item_id: 'function-item', arguments: argumentsJson }
    });
    events.push({
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          output: [
            {
              id: 'function-item',
              type: 'function_call',
              call_id: 'large-call',
              name: 'store',
              arguments: argumentsJson
            }
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }
      }
    });
    setHttpClient({ fetch: async () => eventStream(events) });

    const message = await streamAi(
      { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', provider: 'openai-responses', apiKey: 'openai-secret' },
      [{ role: 'user', content: 'Handle this tool call' }]
    ).collect();

    expect(message.stopReason).toBe('tool_use');
    expect(message.content).toEqual([{ type: 'toolCall', id: 'large-call', name: 'store', arguments: { payload } }]);
  });
});
