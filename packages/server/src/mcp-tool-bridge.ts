import type { ExtensionHost, ToolRegistry } from '@inkpi/agent-core';
import type { AgentTool, ImageContent, TextContent, ToolRegistrationOptions, ToolResult } from '@inkpi/protocol';

export interface McpToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: {
    readonly readOnlyHint?: boolean;
  };
}

export interface McpProgressNotification {
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export interface McpToolCallResult {
  readonly content?: readonly unknown[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** Structural subset implemented by a connected MCP client, including @earendil-works/pi-mcp. */
export interface McpToolClient {
  listTools(options?: { signal?: AbortSignal }): Promise<readonly McpToolDefinition[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
      onProgress?: (progress: McpProgressNotification) => void;
    }
  ): Promise<McpToolCallResult>;
}

export interface McpToolBridgeOptions {
  /** Stable namespace for tools from this configured server. */
  readonly serverId: string;
  /** Caller owns the MCP connection and its transport lifecycle. */
  readonly client: McpToolClient;
  readonly toolRegistry: ToolRegistry;
  /** When supplied, the same tools are also registered in the extension host. */
  readonly extensionHost?: ExtensionHost;
  /** Exact remote tool names approved by the host for exposure to InkPi. */
  readonly allowedToolNames?: readonly string[];
}

export interface McpToolBridgeRegistration {
  readonly toolNames: readonly string[];
  /** Removes only registrations created by this call. The caller still owns the MCP connection. */
  dispose(): void;
}

interface RegisteredTool {
  readonly tool: AgentTool;
  readonly releaseExtensionHostRegistration?: () => void;
}

const MCP_TOOL_REGISTRATION: ToolRegistrationOptions = {
  source: 'mcp',
  capabilities: ['mcp']
};

/**
 * Bridges tools from an already-connected MCP client into InkPi's runtime registries.
 * MCP annotations are server-supplied hints and cannot authorize tool exposure. The host must
 * explicitly allowlist every remote tool that should be registered with InkPi.
 */
export async function registerMcpTools(options: McpToolBridgeOptions): Promise<McpToolBridgeRegistration> {
  const namespace = normalizeSegment(options.serverId, 'MCP server id');
  const allowedToolNames = new Set(options.allowedToolNames ?? []);
  const remoteTools = await options.client.listTools();
  const selected = remoteTools.filter((tool) => allowedToolNames.has(tool.name));
  const agentTools = selected.map((tool) => createAgentTool(namespace, tool, options.client));
  const toolNames = agentTools.map((tool) => tool.name);

  assertUniqueNames(toolNames);
  const existingRuntimeNames = new Set(options.toolRegistry.getAll().map((tool) => tool.name));
  const existingHostNames = new Set(options.extensionHost?.getTools().map((tool) => tool?.name) ?? []);
  for (const name of toolNames) {
    if (existingRuntimeNames.has(name) || existingHostNames.has(name)) {
      throw new Error(`MCP tool name '${name}' is already registered.`);
    }
  }

  const registration: ToolRegistrationOptions = {
    ...MCP_TOOL_REGISTRATION,
    capabilities: ['mcp', `mcp-server:${namespace}`]
  };
  const registered: RegisteredTool[] = [];

  try {
    for (const tool of agentTools) {
      options.toolRegistry.register(tool, registration);
      try {
        const releaseExtensionHostRegistration = options.extensionHost?.registerTool(tool, registration);
        registered.push({ tool, ...(releaseExtensionHostRegistration ? { releaseExtensionHostRegistration } : {}) });
      } catch (error) {
        if (options.toolRegistry.get(tool.name) === tool) options.toolRegistry.unregister(tool.name);
        throw error;
      }
    }
  } catch (error) {
    disposeRegisteredTools(registered, options.toolRegistry);
    throw error;
  }

  let disposed = false;
  return {
    toolNames,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      disposeRegisteredTools(registered, options.toolRegistry);
    }
  };
}

function createAgentTool(namespace: string, remoteTool: McpToolDefinition, client: McpToolClient): AgentTool {
  const remoteName = normalizeSegment(remoteTool.name, 'MCP tool name');
  const parameters = normalizeInputSchema(remoteTool.inputSchema, remoteTool.name);
  const name = toInkPiToolName(namespace, remoteName);

  return {
    name,
    label: remoteTool.title ?? remoteTool.name,
    description: remoteTool.description ?? remoteTool.title ?? `MCP tool ${remoteTool.name}`,
    parameters,
    replay: 'never',
    execute: async (_toolCallId, args, signal, onUpdate): Promise<ToolResult> => {
      const result = await client.callTool(remoteTool.name, args as Record<string, unknown>, {
        ...(signal ? { signal } : {}),
        onProgress: (progress) => {
          const message = progress.message?.trim();
          const text =
            message ||
            (progress.total === undefined
              ? `MCP progress ${progress.progress}`
              : `MCP progress ${progress.progress}/${progress.total}`);
          onUpdate?.({ content: [{ type: 'text', text }] });
        }
      });
      const content = toInkPiContent(result.content ?? []);
      if (result.isError === true && content.length === 0) {
        content.push({ type: 'text', text: `MCP tool ${remoteTool.name} failed` });
      }
      return {
        content,
        ...(result.structuredContent === undefined ? {} : { details: result.structuredContent }),
        isError: result.isError === true
      };
    }
  };
}

function normalizeInputSchema(schema: Readonly<Record<string, unknown>>, toolName: string): Record<string, unknown> {
  if (schema.type !== undefined && schema.type !== 'object') {
    throw new Error(`MCP tool '${toolName}' input schema must describe an object.`);
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  return { ...schema, type: 'object', properties };
}

function toInkPiContent(blocks: readonly unknown[]): (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image' && typeof block.data === 'string') {
      content.push({
        type: 'image',
        image: block.data,
        ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {})
      });
      continue;
    }
    if (block.type === 'resource' && isRecord(block.resource)) {
      const resource = block.resource;
      if (typeof resource.text === 'string') {
        content.push({ type: 'text', text: resource.text });
        continue;
      }
      if (
        typeof resource.blob === 'string' &&
        typeof resource.mimeType === 'string' &&
        resource.mimeType.startsWith('image/')
      ) {
        content.push({ type: 'image', image: resource.blob, mimeType: resource.mimeType });
        continue;
      }
      const uri = typeof resource.uri === 'string' ? ` ${resource.uri}` : '';
      content.push({ type: 'text', text: `[MCP resource${uri} is not directly supported]` });
      continue;
    }
    content.push({
      type: 'text',
      text: `[Unsupported MCP content${typeof block.type === 'string' ? `: ${block.type}` : ''}]`
    });
  }
  return content;
}

function toInkPiToolName(namespace: string, remoteName: string): string {
  const normalized = `mcp_${namespace}_${remoteName}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized.length <= 64) return normalized;
  return `${normalized.slice(0, 56)}_${stableHash(normalized)}`;
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16_777_619) >>> 0;
  }
  return hash.toString(36).padStart(7, '0');
}

function normalizeSegment(value: string, label: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) throw new Error(`${label} must contain an ASCII letter or number.`);
  return normalized;
}

function assertUniqueNames(names: readonly string[]): void {
  const unique = new Set(names);
  if (unique.size !== names.length) throw new Error('MCP tool names collide after InkPi name normalization.');
}

function disposeRegisteredTools(registered: readonly RegisteredTool[], toolRegistry: ToolRegistry): void {
  for (const { tool, releaseExtensionHostRegistration } of [...registered].reverse()) {
    if (toolRegistry.get(tool.name) === tool) toolRegistry.unregister(tool.name);
    releaseExtensionHostRegistration?.();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
