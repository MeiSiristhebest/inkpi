import { Agent } from '@inkpi/agent-core';
import { setHttpClient } from '@inkpi/ai';
import type { ModelConfig } from '@inkpi/ai';
import type { AgentTool } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { afterEach, describe, expect, it } from 'vitest';

interface AnthropicToolPayload {
  name: string;
  description: string;
  input_schema: unknown;
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
}

interface AnthropicRequestPayload {
  model: string;
  tools?: AnthropicToolPayload[];
  thinking?: { type: string; budget_tokens?: number };
}

function responseFrom(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 });
}

function toolSearchResponse(): Response {
  return responseFrom([
    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'search-call', name: 'tool_search', input: {} }
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"query":"deferred lookup"}' }
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', usage: { output_tokens: 1 } },
    { type: 'message_stop' }
  ]);
}

function textResponse(): Response {
  return responseFrom([
    { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
    { type: 'message_delta', usage: { output_tokens: 1 } },
    { type: 'message_stop' }
  ]);
}

function makeTool(name: string, description: string): AgentTool {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
  };
}

function cacheModel(id: string): ModelConfig {
  return {
    id,
    name: id,
    provider: 'claude',
    routeId: `route-${id}`,
    baseUrl: 'https://provider.test/v1',
    apiKey: 'test-key',
    maxTokens: 4096,
    supportsThinking: true,
    supportsPromptCache: true,
    cacheControl: { type: 'ephemeral' }
  };
}

function createAgent(
  journal: AppendOnlySessionJournal,
  model: ModelConfig,
  direct: AgentTool,
  deferred: AgentTool
): Agent {
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: 'Stable runtime instructions.',
      tools: [deferred, direct]
    },
    journal,
    toolDiscovery: true
  });
  agent.getToolRegistry().register(deferred, { source: 'extension', exposure: 'deferred' });
  agent.getToolRegistry().register(direct, { source: 'host' });
  return agent;
}

describe('provider tool-loadout cache prefixes', () => {
  afterEach(() => setHttpClient(null));

  it('keeps the Anthropic stable direct-tool prefix across deferred activation, recovery, model switch and revocation', async () => {
    const journal = new AppendOnlySessionJournal('provider-loadout-cache-prefix');
    const direct = makeTool('host_status', 'Read stable host status');
    const deferred = makeTool('deferred_lookup', 'Look up deferred records');
    const responses = [toolSearchResponse(), textResponse(), textResponse(), textResponse()];
    const requests: AnthropicRequestPayload[] = [];
    setHttpClient({
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as AnthropicRequestPayload);
        const response = responses.shift();
        if (!response) throw new Error('Unexpected Anthropic request in fixture.');
        return response;
      }
    });

    const first = createAgent(journal, cacheModel('claude-cache-prefix-a'), direct, deferred);
    await first.prompt('Find a deferred lookup tool.');

    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['host_status', 'tool_search']);
    expect(requests[1]?.tools?.map((tool) => tool.name)).toEqual(['host_status', 'tool_search', 'deferred_lookup']);
    for (const request of requests.slice(0, 2)) {
      expect(request.tools?.[1]).toMatchObject({ cache_control: { type: 'ephemeral' } });
      expect(request.tools?.slice(2).some((tool) => tool.cache_control !== undefined)).toBe(false);
    }

    const recovered = createAgent(journal, cacheModel('claude-cache-prefix-b'), direct, deferred);
    recovered.state.thinkingLevel = 'high';
    await recovered.prompt('Continue after recovery on the selected model.');

    expect(requests[2]?.model).toBe('claude-cache-prefix-b');
    expect(requests[2]?.thinking).toEqual({ type: 'enabled', budget_tokens: 3072 });
    expect(requests[2]?.tools?.map((tool) => tool.name)).toEqual(['host_status', 'tool_search', 'deferred_lookup']);
    expect(requests[2]?.tools?.[1]).toMatchObject({ cache_control: { type: 'ephemeral' } });

    recovered.getToolRegistry().unregister(deferred.name);
    await recovered.prompt('Continue after the deferred tool was revoked.');

    expect(requests[3]?.tools?.map((tool) => tool.name)).toEqual(['host_status', 'tool_search']);
    expect(requests[3]?.tools?.[1]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(JSON.stringify(requests[3]?.tools)).not.toContain('deferred_lookup');
  });
});
