import { setHttpClient, streamAi } from '@inkpi/ai';
import type { ModelConfig } from '@inkpi/ai';
import type { AgentMessage } from '@inkpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(() => setHttpClient(null));

function model(): ModelConfig {
  return {
    id: 'chatgpt-plan-model',
    name: 'ChatGPT Plan Model',
    provider: 'openai-chatgpt-plan',
    baseUrl: 'https://untrusted.invalid/v1',
    apiKey: 'account-access-token'
  };
}

function eventStream(events: Array<{ event: string; data: unknown }>): Response {
  const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('ChatGPT plan Responses API provider', () => {
  it('uses the fixed Responses endpoint and emits text and usage events', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    setHttpClient({
      fetch: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return eventStream([
          { event: 'response.output_text.delta', data: { delta: 'response ' } },
          { event: 'response.output_text.delta', data: { delta: 'text' } },
          {
            event: 'response.completed',
            data: {
              response: {
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'response text' }] }],
                usage: {
                  input_tokens: 12,
                  output_tokens: 4,
                  total_tokens: 16,
                  input_tokens_details: { cached_tokens: 2 }
                }
              }
            }
          }
        ]);
      }
    });

    const message = await streamAi(model(), [{ role: 'user', content: 'Hello' }]).collect();

    expect(requestUrl).toBe('https://api.openai.com/v1/responses');
    expect(requestInit?.method).toBe('POST');
    expect(requestInit?.headers).toMatchObject({
      Accept: 'text/event-stream',
      Authorization: 'Bearer account-access-token',
      'Content-Type': 'application/json'
    });
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      model: 'chatgpt-plan-model',
      input: [{ role: 'user', content: 'Hello' }],
      stream: true,
      store: false
    });
    expect(message.stopReason).toBe('stop');
    expect(message.content).toEqual([{ type: 'text', text: 'response text' }]);
    expect(message.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 16,
      promptTokens: 12,
      cacheReadTokens: 2
    });
  });

  it('converts tool history and declarations to Responses API items', async () => {
    let requestBody: Record<string, unknown> | undefined;
    setHttpClient({
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return eventStream([
          {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              item: { id: 'fc_item_1', type: 'function_call', call_id: 'call_new', name: 'lookup', arguments: '' }
            }
          },
          {
            event: 'response.function_call_arguments.delta',
            data: { type: 'response.function_call_arguments.delta', item_id: 'fc_item_1', delta: '{"query":"' }
          },
          {
            event: 'response.function_call_arguments.delta',
            data: { type: 'response.function_call_arguments.delta', item_id: 'fc_item_1', delta: 'north"}' }
          },
          {
            event: 'response.function_call_arguments.done',
            data: {
              type: 'response.function_call_arguments.done',
              item_id: 'fc_item_1',
              arguments: '{"query":"north"}'
            }
          },
          {
            event: 'response.completed',
            data: {
              response: {
                output: [
                  {
                    id: 'fc_item_1',
                    type: 'function_call',
                    call_id: 'call_new',
                    name: 'lookup',
                    arguments: '{"query":"north"}'
                  }
                ],
                usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 }
              }
            }
          }
        ]);
      }
    });

    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_old', name: 'lookup', arguments: { query: 'south' } }]
      },
      {
        role: 'toolResult',
        toolCallId: 'call_old',
        toolName: 'lookup',
        content: [{ type: 'text', text: 'previous result' }]
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this image' },
          { type: 'image', image: 'aGVsbG8=', mimeType: 'image/jpeg' }
        ]
      }
    ];
    const message = await streamAi(model(), messages, {
      systemPrompt: 'Use lookup when helpful.',
      tools: [{ name: 'lookup', description: 'Find a record', parameters: { type: 'object', properties: {} } }]
    }).collect();

    expect(requestBody).toMatchObject({
      input: [
        { role: 'developer', content: 'Use lookup when helpful.' },
        { type: 'function_call', call_id: 'call_old', name: 'lookup', arguments: '{"query":"south"}' },
        { type: 'function_call_output', call_id: 'call_old', output: 'previous result' },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'Read this image' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,aGVsbG8=' }
          ]
        }
      ],
      tools: [{ type: 'function', name: 'lookup', description: 'Find a record' }]
    });
    expect(message.stopReason).toBe('tool_use');
    expect(message.content).toEqual([
      { type: 'toolCall', id: 'call_new', name: 'lookup', arguments: { query: 'north' } }
    ]);
  });

  it('requires an account access token and does not make a request without one', async () => {
    let requested = false;
    setHttpClient({
      fetch: async () => {
        requested = true;
        return eventStream([]);
      }
    });
    const result = await streamAi({ ...model(), apiKey: undefined }, [{ role: 'user', content: 'Hello' }]).collect();
    expect(requested).toBe(false);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('did not provide an access token');
  });
});
