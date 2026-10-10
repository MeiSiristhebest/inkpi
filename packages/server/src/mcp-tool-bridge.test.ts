import { ExtensionHost, ToolRegistry } from '@inkpi/agent-core';
import type { AgentTool, ToolCallContent } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { registerMcpTools } from './mcp-tool-bridge.js';
import type { McpToolBridgeOptions, McpToolCallResult, McpToolClient, McpToolDefinition } from './mcp-tool-bridge.js';

function toolCall(name: string, arguments_: Record<string, unknown>): ToolCallContent {
  return { type: 'toolCall', id: `test-${name}`, name, arguments: arguments_ };
}

function mcpTool(name: string, readOnlyHint?: boolean): McpToolDefinition {
  return {
    name,
    description: `Remote ${name}`,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } })
  };
}

class FakeMcpClient implements McpToolClient {
  readonly calls: Array<{
    name: string;
    args?: Record<string, unknown>;
    signal?: AbortSignal;
  }> = [];

  constructor(
    readonly tools: readonly McpToolDefinition[],
    readonly result: McpToolCallResult = { content: [{ type: 'text', text: 'ok' }] }
  ) {}

  async listTools(): Promise<readonly McpToolDefinition[]> {
    return this.tools;
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: { progress: number; total?: number; message?: string }) => void;
    }
  ): Promise<McpToolCallResult> {
    this.calls.push({ name, ...(args ? { args } : {}), ...(options?.signal ? { signal: options.signal } : {}) });
    options?.onProgress?.({ progress: 1, total: 2, message: 'Reading files' });
    return this.result;
  }
}

function bridgeOptions(
  client: McpToolClient,
  toolRegistry = new ToolRegistry(),
  extensionHost = new ExtensionHost(),
  extra: Partial<McpToolBridgeOptions> = {}
): McpToolBridgeOptions {
  return { serverId: 'workspace', client, toolRegistry, extensionHost, ...extra };
}

describe('MCP tool bridge', () => {
  it('registers host-approved tools, forwards calls and progress, and maps results', async () => {
    const client = new FakeMcpClient([mcpTool('search', true), mcpTool('delete', false), mcpTool('unclassified')], {
      content: [
        { type: 'text', text: 'found' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'audio', data: 'AA==', mimeType: 'audio/wav' }
      ],
      structuredContent: { count: 1 }
    });
    const toolRegistry = new ToolRegistry();
    const extensionHost = new ExtensionHost();
    const registration = await registerMcpTools({
      ...bridgeOptions(client, toolRegistry, extensionHost),
      allowedToolNames: ['search']
    });

    expect(registration.toolNames).toEqual(['mcp_workspace_search']);
    expect(toolRegistry.getRegistration('mcp_workspace_search')).toMatchObject({
      source: 'mcp',
      capabilities: ['mcp', 'mcp-server:workspace']
    });
    expect(extensionHost.getTools().map((tool) => tool.name)).toEqual(['mcp_workspace_search']);

    const controller = new AbortController();
    const updates: Array<{ content: Array<{ type: string; text?: string }> }> = [];
    const result = await toolRegistry.executeTool(
      toolCall('mcp_workspace_search', { query: 'Mira' }),
      controller.signal,
      (update) => updates.push(update)
    );

    expect(client.calls).toEqual([{ name: 'search', args: { query: 'Mira' }, signal: controller.signal }]);
    expect(updates).toEqual([{ content: [{ type: 'text', text: 'Reading files' }] }]);
    expect(result).toMatchObject({
      isError: false,
      details: { count: 1 },
      content: [
        { type: 'text', text: 'found' },
        { type: 'image', image: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'text', text: '[Unsupported MCP content: audio]' }
      ]
    });

    registration.dispose();
    registration.dispose();
    expect(toolRegistry.get('mcp_workspace_search')).toBeUndefined();
    expect(extensionHost.getTools()).toEqual([]);
  });

  it('does not treat server annotations as authorization to expose tools', async () => {
    const client = new FakeMcpClient([mcpTool('search', true), mcpTool('write_file', false), mcpTool('delete_file')]);
    const toolRegistry = new ToolRegistry();
    const registration = await registerMcpTools({
      serverId: 'workspace',
      client,
      toolRegistry
    });

    expect(registration.toolNames).toEqual([]);
    expect(toolRegistry.getAll()).toEqual([]);
    registration.dispose();

    const approved = await registerMcpTools({
      serverId: 'workspace',
      client,
      toolRegistry,
      allowedToolNames: ['write_file']
    });

    expect(approved.toolNames).toEqual(['mcp_workspace_write_file']);
    expect(toolRegistry.get('mcp_workspace_search')).toBeUndefined();
    expect(toolRegistry.get('mcp_workspace_delete_file')).toBeUndefined();
    approved.dispose();
  });

  it('rejects sanitized-name collisions before registering any tools', async () => {
    const client = new FakeMcpClient([mcpTool('read.tool', true), mcpTool('read/tool', true)]);
    const toolRegistry = new ToolRegistry();
    const extensionHost = new ExtensionHost();

    await expect(
      registerMcpTools({
        ...bridgeOptions(client, toolRegistry, extensionHost),
        allowedToolNames: ['read.tool', 'read/tool']
      })
    ).rejects.toThrow('MCP tool names collide');
    expect(toolRegistry.getAll()).toEqual([]);
    expect(extensionHost.getTools()).toEqual([]);
  });

  it('does not remove later replacements when the registration is disposed', async () => {
    const client = new FakeMcpClient([mcpTool('search', true)]);
    const toolRegistry = new ToolRegistry();
    const extensionHost = new ExtensionHost();
    const registration = await registerMcpTools(bridgeOptions(client, toolRegistry, extensionHost));
    const replacement: AgentTool = {
      name: 'mcp_workspace_search',
      description: 'replacement',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'replacement' }] })
    };
    toolRegistry.register(replacement);
    extensionHost.registerTool(replacement);

    registration.dispose();

    expect(toolRegistry.get(replacement.name)).toBe(replacement);
    expect(extensionHost.getTools()).toEqual([replacement]);
  });

  it('rejects non-object remote schemas before making registrations', async () => {
    const client = new FakeMcpClient([{ ...mcpTool('search', true), inputSchema: { type: 'string' } }]);
    const toolRegistry = new ToolRegistry();
    const extensionHost = new ExtensionHost();

    await expect(
      registerMcpTools({
        ...bridgeOptions(client, toolRegistry, extensionHost),
        allowedToolNames: ['search']
      })
    ).rejects.toThrow('input schema must describe an object');
    expect(toolRegistry.getAll()).toEqual([]);
    expect(extensionHost.getTools()).toEqual([]);
  });
});
