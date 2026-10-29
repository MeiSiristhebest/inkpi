import { Agent, createCodemodeTool } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import type { StreamOptions } from '@inkpi/ai';
import type { AgentTool, ToolResult } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  TOOL_SEARCH_MAX_DESCRIPTION_LENGTH,
  TOOL_SEARCH_MAX_RESULT_BYTES,
  TOOL_SEARCH_MAX_SCHEMA_BYTES,
  TOOL_SEARCH_NAME,
  createToolSearchTool,
  readToolSearchActivations
} from '../packages/agent-core/src/tool-discovery.js';

function answer(text = 'answer'): AssistantEventStream {
  const stream = new AssistantEventStream();
  stream.push({ type: 'text_delta', textDelta: text });
  stream.end();
  return stream;
}

function toolCall(name: string, args: Record<string, unknown>, id = 'tool-call'): AssistantEventStream {
  const stream = new AssistantEventStream();
  stream.push({ type: 'tool_call_start', toolCallId: id, toolName: name });
  stream.push({
    type: 'tool_call_end',
    toolCall: { type: 'toolCall', id, name, arguments: args }
  });
  stream.end();
  return stream;
}

function makeTool(
  name: string,
  description = name,
  parameters: unknown = { type: 'object' },
  execute: AgentTool['execute'] = async () => ({ content: [{ type: 'text', text: 'ok' }] })
): AgentTool {
  return { name, description, parameters, execute };
}

function names(tools: StreamOptions['tools']): string[] {
  return (tools ?? []).map((tool) => tool.name);
}

function schemaBytes(tools: StreamOptions['tools']): number {
  return Buffer.byteLength(JSON.stringify(tools ?? []), 'utf8');
}

function toolResultTexts(agent: Agent, name: string): string[] {
  return agent.state.messages.flatMap((message) => {
    if (message.role !== 'toolResult' || message.toolName !== name || !Array.isArray(message.content)) return [];
    const block = message.content.find(
      (item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string'
    );
    return block ? [block.text] : [];
  });
}

function toolResultText(agent: Agent, name: string): string {
  return toolResultTexts(agent, name)[0] ?? '';
}

describe('opt-in local tool discovery', () => {
  it('keeps legacy tools direct by default and bounds the schema payload with 120 deferred tools', async () => {
    const direct = makeTool('direct_status', 'Read the current status');
    const hidden = makeTool('hidden_secret', 'Never expose this tool');
    const deferred = Array.from({ length: 120 }, (_, index) =>
      makeTool(
        `deferred_invoice_${index}`,
        `Search synthetic invoice records for ${index}${index === 119 ? ` ${'x'.repeat(900)}` : ''}`,
        { type: 'object', properties: { invoiceId: { type: 'string' } }, required: ['invoiceId'] }
      )
    );

    const legacyRequests: Array<StreamOptions | undefined> = [];
    const legacyAgent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      streamFn: (_model, _messages, options) => {
        legacyRequests.push(options);
        return answer();
      }
    });
    legacyAgent.getToolRegistry().register(direct);
    for (const tool of deferred) legacyAgent.getToolRegistry().register(tool, { exposure: 'deferred' });
    legacyAgent.getToolRegistry().register(hidden, { exposure: 'hidden' });
    expect(legacyAgent.getToolRegistry().getRegistration('direct_status')).not.toHaveProperty('exposure');
    await legacyAgent.prompt('same fixture');

    const discoveryRequests: Array<StreamOptions | undefined> = [];
    let discoveryCall = 0;
    const discoveryAgent = new Agent({
      toolDiscovery: true,
      initialState: { model: getModelPreset('mock-test') },
      streamFn: (_model, _messages, options) => {
        discoveryRequests.push(options);
        const index = discoveryCall++;
        if (index === 0) return toolCall(TOOL_SEARCH_NAME, { query: 'invoice' });
        if (index === 1) return toolCall(TOOL_SEARCH_NAME, { query: 'invoice 119' });
        return answer();
      }
    });
    discoveryAgent.getToolRegistry().register(direct);
    for (const tool of deferred) discoveryAgent.getToolRegistry().register(tool, { exposure: 'deferred' });
    discoveryAgent.getToolRegistry().register(hidden, { exposure: 'hidden' });
    await discoveryAgent.prompt('same fixture');

    const legacyNames = names(legacyRequests[0]?.tools);
    const initialNames = names(discoveryRequests[0]?.tools);
    expect(legacyNames).toContain('deferred_invoice_119');
    expect(initialNames).toContain('direct_status');
    expect(initialNames).toContain(TOOL_SEARCH_NAME);
    expect(initialNames.some((name) => name.startsWith('deferred_invoice_'))).toBe(false);
    expect(initialNames).not.toContain('hidden_secret');
    expect(names(discoveryRequests[1]?.tools).filter((name) => name.startsWith('deferred_invoice_'))).toHaveLength(8);
    expect(names(discoveryRequests[2]?.tools)).toContain('deferred_invoice_119');
    expect(discoveryRequests[2]?.tools?.find((tool) => tool.name === 'deferred_invoice_119')?.parameters).toMatchObject(
      {
        properties: { invoiceId: { type: 'string' } }
      }
    );

    const baselineBytes = schemaBytes(legacyRequests[0]?.tools);
    const discoveryBytes = schemaBytes(discoveryRequests[0]?.tools);
    expect(discoveryBytes).toBeLessThan(baselineBytes);
    console.info(
      `M6 provider tool-schema fixture: baseline=${baselineBytes} bytes (~${Math.ceil(baselineBytes / 4)} tokens); discovery=${discoveryBytes} bytes (~${Math.ceil(discoveryBytes / 4)} tokens)`
    );

    const resultTexts = toolResultTexts(discoveryAgent, TOOL_SEARCH_NAME);
    expect(resultTexts).toHaveLength(2);
    expect(Buffer.byteLength(resultTexts[0]!, 'utf8')).toBeLessThanOrEqual(TOOL_SEARCH_MAX_RESULT_BYTES);
    const boundedResults = JSON.parse(resultTexts[0]!) as Array<{ name: string; description: string }>;
    expect(boundedResults).toHaveLength(8);
    const targetedResults = JSON.parse(resultTexts[1]!) as Array<{ name: string; description: string }>;
    expect(targetedResults.map((item) => item.name)).toContain('deferred_invoice_119');
    expect(
      targetedResults.find((item) => item.name === 'deferred_invoice_119')?.description.length
    ).toBeLessThanOrEqual(TOOL_SEARCH_MAX_DESCRIPTION_LENGTH + 1);
  });

  it('does not expose hidden tools or execute unapproved tools through Codemode or guessed names', async () => {
    const hiddenExecute = vi.fn(async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'secret' }] }));
    const hidden = makeTool('hidden_read', 'Hidden read tool', { type: 'object' }, hiddenExecute);
    const unapprovedReadExecute = vi.fn(
      async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'unapproved' }] })
    );
    const unapprovedRead = makeTool(
      'unapproved_read',
      'Unapproved read tool',
      { type: 'object' },
      unapprovedReadExecute
    );
    const codemode = createCodemodeTool({ allowedReadTools: [TOOL_SEARCH_NAME, 'hidden_read', 'unapproved_read'] });
    const requests: Array<StreamOptions | undefined> = [];
    let requestCount = 0;
    const agent = new Agent({
      toolDiscovery: true,
      initialState: { model: getModelPreset('mock-test'), tools: [codemode] },
      streamFn: (_model, _messages, options) => {
        requests.push(options);
        const index = requestCount++;
        if (index === 0) return toolCall('codemode', { code: 'await tools.tool_search({query: "hidden"})' });
        if (index === 1) return toolCall('codemode', { code: 'await tools.unapproved_read({})' });
        if (index === 2) return toolCall('hidden_read', {});
        return answer();
      }
    });
    agent.getToolRegistry().register(codemode, { source: 'runtime', capabilities: ['compute'] });
    agent
      .getToolRegistry()
      .register(hidden, { source: 'host-approved-read', capabilities: ['read'], exposure: 'hidden' });
    agent.getToolRegistry().register(unapprovedRead, { source: 'extension', exposure: 'deferred' });
    const searchTool = agent.getToolRegistry().get(TOOL_SEARCH_NAME)!;
    const searchExecute = vi.spyOn(searchTool, 'execute');

    await agent.prompt('try the nested and guessed paths');

    expect(names(requests[0]?.tools)).not.toContain('hidden_read');
    expect(names(requests[0]?.tools)).not.toContain('unapproved_read');
    expect(agent.getToolRegistry().getRegistration(TOOL_SEARCH_NAME)).toMatchObject({
      capabilities: ['tool-discovery']
    });
    expect(searchExecute).not.toHaveBeenCalled();
    expect(hiddenExecute).not.toHaveBeenCalled();
    expect(unapprovedReadExecute).not.toHaveBeenCalled();
    expect(agent.getToolRegistry().getRegistration('hidden_read')).toMatchObject({
      exposure: 'hidden',
      capabilities: ['read']
    });
    expect(agent.getToolRegistry().getRegistration('unapproved_read')).toMatchObject({
      exposure: 'deferred',
      capabilities: []
    });
  });

  it('isolates search candidates to each Agent workspace', async () => {
    const run = async (ownName: string, query: string) => {
      const requests: Array<StreamOptions | undefined> = [];
      let requestCount = 0;
      const agent = new Agent({
        toolDiscovery: true,
        initialState: { model: getModelPreset('mock-test') },
        streamFn: (_model, _messages, options) => {
          requests.push(options);
          return requestCount++ === 0 ? toolCall(TOOL_SEARCH_NAME, { query }) : answer();
        }
      });
      agent.getToolRegistry().register(makeTool(ownName, 'workspace-only ledger lookup'), { exposure: 'deferred' });
      await agent.prompt('search workspace tools');
      return { requests, resultText: toolResultText(agent, TOOL_SEARCH_NAME) };
    };

    const alpha = await run('alpha_ledger_lookup', 'workspace ledger lookup');
    const beta = await run('beta_ledger_lookup', 'workspace ledger lookup');
    expect(alpha.resultText).toContain('alpha_ledger_lookup');
    expect(alpha.resultText).not.toContain('beta_ledger_lookup');
    expect(beta.resultText).toContain('beta_ledger_lookup');
    expect(beta.resultText).not.toContain('alpha_ledger_lookup');
    expect(names(alpha.requests[0]?.tools)).not.toContain('beta_ledger_lookup');
    expect(names(beta.requests[0]?.tools)).not.toContain('alpha_ledger_lookup');
  });

  it('does not activate a stale same-name tool after its schema changes during the after hook', async () => {
    const oldTool = makeTool('deferred_lookup', 'Lookup records', {
      type: 'object',
      properties: { oldKey: { type: 'string' } }
    });
    const replacementExecute = vi.fn(async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'new' }] }));
    const replacement = makeTool(
      'deferred_lookup',
      'Lookup records',
      { type: 'object', properties: { newKey: { type: 'string' } } },
      replacementExecute
    );
    const requests: Array<StreamOptions | undefined> = [];
    let requestCount = 0;
    const agent = new Agent({
      toolDiscovery: true,
      initialState: { model: getModelPreset('mock-test') },
      afterToolCall: async ({ toolCall: call }) => {
        if (call.name === TOOL_SEARCH_NAME) agent.getToolRegistry().register(replacement, { exposure: 'deferred' });
        return undefined;
      },
      streamFn: (_model, _messages, options) => {
        requests.push(options);
        const index = requestCount++;
        if (index === 0) return toolCall(TOOL_SEARCH_NAME, { query: 'deferred lookup' });
        if (index === 1) return toolCall('deferred_lookup', { newKey: 'x' });
        return answer();
      }
    });
    agent.getToolRegistry().register(oldTool, { exposure: 'deferred' });

    await agent.prompt('lookup a record');

    expect(names(requests[1]?.tools)).not.toContain('deferred_lookup');
    expect(replacementExecute).not.toHaveBeenCalled();
    const rejected = agent.state.messages.find(
      (message) => message.role === 'toolResult' && message.toolName === 'deferred_lookup'
    );
    expect(rejected).toMatchObject({ isError: true });
  });

  it('restores persisted declarations, switches branches, and filters a revoked plugin', async () => {
    const journal = new AppendOnlySessionJournal('tool-discovery-restore');
    const deferredTool = makeTool('deferred_branch_lookup', 'Lookup branch records', { type: 'object' });
    const initialRequests: Array<StreamOptions | undefined> = [];
    let initialRequestCount = 0;
    let preSearchHead: string | null | undefined;
    const agent = new Agent({
      toolDiscovery: true,
      initialState: { model: getModelPreset('mock-test') },
      journal,
      prepareRequest: () => {
        preSearchHead ??= agent.getModelContext().headId;
        return undefined;
      },
      streamFn: (_model, _messages, options) => {
        initialRequests.push(options);
        return initialRequestCount++ === 0 ? toolCall(TOOL_SEARCH_NAME, { query: 'branch records' }) : answer();
      }
    });
    agent.getToolRegistry().register(deferredTool, { exposure: 'deferred' });

    await agent.prompt('find branch records');
    expect(names(initialRequests[1]?.tools)).toContain('deferred_branch_lookup');

    const restoredRequests: Array<StreamOptions | undefined> = [];
    const restored = new Agent({
      toolDiscovery: true,
      initialState: { model: getModelPreset('mock-test') },
      journal,
      streamFn: (_model, _messages, options) => {
        restoredRequests.push(options);
        return answer();
      }
    });
    restored.getToolRegistry().register(deferredTool, { exposure: 'deferred' });
    await restored.prompt('resume the persisted loadout');
    expect(names(restoredRequests[0]?.tools)).toContain('deferred_branch_lookup');

    const searchResultId = restored.state.messages.find(
      (message) => message.role === 'toolResult' && message.toolName === TOOL_SEARCH_NAME
    )?.id;
    if (!searchResultId) throw new Error('Expected a persisted tool-search result id.');
    await restored.editContext({ version: 1, edits: [{ action: 'exclude', messageId: searchResultId }] });
    await restored.prompt('continue after context edit');
    expect(names(restoredRequests[1]?.tools)).toContain('deferred_branch_lookup');

    await restored.selectContextHead(preSearchHead ?? null);
    await restored.prompt('use the older branch');
    expect(names(restoredRequests[2]?.tools)).not.toContain('deferred_branch_lookup');

    const journalAfterDiscovery = new AppendOnlySessionJournal('tool-discovery-plugin-revocation');
    const pluginExecute = vi.fn(async (): Promise<ToolResult> => ({ content: [{ type: 'text', text: 'plugin' }] }));
    const pluginTool = makeTool('plugin_deferred_lookup', 'Lookup plugin records', { type: 'object' }, pluginExecute);
    const pluginRequests: Array<StreamOptions | undefined> = [];
    let pluginRequestCount = 0;
    let removePlugin = (): void => {};
    const pluginAgent = new Agent({
      toolDiscovery: true,
      initialState: { model: getModelPreset('mock-test') },
      journal: journalAfterDiscovery,
      streamFn: (_model, _messages, options) => {
        pluginRequests.push(options);
        const index = pluginRequestCount++;
        if (index === 0) return toolCall(TOOL_SEARCH_NAME, { query: 'plugin records' });
        if (index === 1) {
          removePlugin();
          return toolCall('plugin_deferred_lookup', {});
        }
        return answer();
      }
    });
    removePlugin = pluginAgent.getExtensionHost().registerTool(pluginTool, {
      source: 'plugin',
      exposure: 'deferred'
    });

    await pluginAgent.prompt('find and use plugin records');

    expect(names(pluginRequests[1]?.tools)).toContain('plugin_deferred_lookup');
    expect(names(pluginRequests[2]?.tools)).not.toContain('plugin_deferred_lookup');
    expect(pluginExecute).not.toHaveBeenCalled();
  });

  it('does not activate a tool when its declaration exceeds the per-schema result limit', async () => {
    const tool = createToolSearchTool();
    const candidate = makeTool('deferred_oversized_lookup', 'Oversized schema lookup', {
      type: 'object',
      properties: { payload: { type: 'string', description: 'x'.repeat(TOOL_SEARCH_MAX_SCHEMA_BYTES + 1) } }
    });
    const registration = {
      name: candidate.name,
      source: 'runtime',
      capabilities: [],
      exposure: 'deferred' as const
    };
    const result = await tool.execute('oversized', { query: 'oversized lookup' }, undefined, undefined, {
      toolSearch: { candidates: [{ tool: candidate, registration }] }
    });
    const text = result.content.find((item) => item.type === 'text')?.text;
    expect(text).toBeDefined();
    const items = JSON.parse(text ?? '[]') as Array<{ name: string; parametersOmitted?: boolean }>;
    expect(items).toMatchObject([{ name: 'deferred_oversized_lookup', parametersOmitted: true }]);
    expect(items[0]).not.toHaveProperty('parameters');
    expect(readToolSearchActivations(result.details)).toEqual([]);
  });

  it('does not record partial activation for cancelled or failed searches', async () => {
    const tool = createToolSearchTool();
    const candidate = makeTool('deferred_cancel', 'cancel search candidate', { type: 'object' });
    const registration = {
      name: candidate.name,
      source: 'runtime',
      capabilities: [],
      exposure: 'deferred' as const
    };
    const context = { toolSearch: { candidates: [{ tool: candidate, registration }] } };
    const controller = new AbortController();
    controller.abort();
    const cancelled = await tool.execute('cancel', { query: 'cancel' }, controller.signal, undefined, context);
    expect(cancelled.isError).toBe(true);
    expect(readToolSearchActivations(cancelled.details)).toEqual([]);

    const failed = await tool.execute('invalid', { query: '   ' }, undefined, undefined, context);
    expect(failed.isError).toBe(true);
    expect(readToolSearchActivations(failed.details)).toEqual([]);
  });
});
