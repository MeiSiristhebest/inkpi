import { validateSchema } from '@inkpi/protocol';
import type {
  AgentTool,
  TSchema,
  ToolCallContent,
  ToolRegistrationDescriptor,
  ToolRegistrationOptions,
  ToolResult,
  ToolResultMessage,
  ToolUpdateOptions
} from '@inkpi/protocol';
import type { Clock } from './ports/index.js';
import { runWithConcurrency } from './concurrency.js';
import type { ToolExecutionMode } from './types.js';

export {
  detectLineEnding,
  normalizeToLF,
  restoreLineEndings,
  normalizeForFuzzyMatch,
  splitLinesWithEndings,
  fuzzyFindText,
  applyFuzzyTextEdit
} from './tools/edit-diff.js';
export type { DiffFuzzyMatchResult } from './tools/edit-diff.js';
export * from './tools/output-guard.js';
export * from './tools/authoring-tools.js';

export interface ToolRegistryQuery {
  requiredCapabilities?: readonly string[];
}

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  private registrations = new Map<string, ToolRegistrationDescriptor>();
  private readonly clock: Clock;

  constructor(clock: Clock = Date.now) {
    this.clock = clock;
  }

  public register(tool: AgentTool, options: ToolRegistrationOptions = {}): void {
    const descriptor = createToolRegistrationDescriptor(tool, options);
    this.tools.set(tool.name, tool);
    this.registrations.set(tool.name, descriptor);
  }

  public unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    this.registrations.delete(name);
    return removed;
  }

  public get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  public getAll(query: ToolRegistryQuery = {}): AgentTool[] {
    const required = normalizeCapabilities(query.requiredCapabilities);
    if (required.length === 0) return Array.from(this.tools.values());

    return Array.from(this.tools.values()).filter((tool) => {
      const registration = this.registrations.get(tool.name);
      return registration ? hasCapabilities(registration.capabilities, required) : false;
    });
  }

  /** Alias used by capability-aware callers that want an explicit operation name. */
  public getByCapabilities(requiredCapabilities: readonly string[]): AgentTool[] {
    return this.getAll({ requiredCapabilities });
  }

  /** Returns only serializable metadata; tool executors never cross the process boundary. */
  public getRegistrations(): ToolRegistrationDescriptor[] {
    return Array.from(this.registrations.values()).map(cloneToolRegistrationDescriptor);
  }

  public getRegistration(name: string): ToolRegistrationDescriptor | undefined {
    const registration = this.registrations.get(name);
    return registration ? cloneToolRegistrationDescriptor(registration) : undefined;
  }

  public validateParameters(tool: AgentTool, args: Record<string, unknown>): { valid: boolean; error?: string } {
    if (!tool.parameters) return { valid: true };
    const result = validateSchema(tool.parameters as TSchema, args);
    return result.valid
      ? { valid: true }
      : { valid: false, error: result.errors.map((error) => `${error.path} ${error.message}`).join('; ') };
  }

  public async executeTool(
    toolCall: ToolCallContent,
    signal?: AbortSignal,
    onUpdate?: (update: { content: any[]; details?: unknown }, options?: ToolUpdateOptions) => void,
    context?: unknown
  ): Promise<ToolResultMessage & { terminate?: boolean }> {
    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      return {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        isError: true,
        content: [{ type: 'text', text: `Tool '${toolCall.name}' not found in registry` }],
        timestamp: this.clock()
      };
    }

    const validation = this.validateParameters(tool, toolCall.arguments);
    if (!validation.valid) {
      return {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        isError: true,
        content: [{ type: 'text', text: `Parameter Validation Error: ${validation.error}` }],
        timestamp: this.clock()
      };
    }

    try {
      if (signal?.aborted) {
        return {
          role: 'toolResult',
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          isError: true,
          content: [{ type: 'text', text: 'Tool execution aborted by signal' }],
          timestamp: this.clock()
        };
      }

      const result: ToolResult = await tool.execute(toolCall.id, toolCall.arguments, signal, onUpdate, context);

      return {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: result.content,
        details: result.details,
        isError: result.isError ?? false,
        terminate: result.terminate,
        timestamp: this.clock()
      };
    } catch (err: any) {
      return {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        isError: true,
        content: [{ type: 'text', text: `Tool Exception: ${err?.message || String(err)}` }],
        timestamp: this.clock()
      };
    }
  }

  public async executeBatch(
    toolCalls: ToolCallContent[],
    mode: ToolExecutionMode = 'parallel',
    signal?: AbortSignal,
    onProgress?: (toolCallId: string, partial: any) => void,
    context?: unknown
  ): Promise<Array<ToolResultMessage & { terminate?: boolean }>> {
    if (toolCalls.length === 0) return [];

    return runWithConcurrency(
      toolCalls,
      (call) => this.executeTool(call, signal, (update) => onProgress?.(call.id, update), context),
      mode
    );
  }
}

export function createToolRegistrationDescriptor(
  tool: Pick<AgentTool, 'name'>,
  options: ToolRegistrationOptions = {}
): ToolRegistrationDescriptor {
  if (!tool || typeof tool.name !== 'string' || tool.name.trim().length === 0) {
    throw new Error('Tool name must not be empty');
  }

  const source = typeof options.source === 'string' && options.source.trim().length > 0
    ? options.source.trim()
    : options.skillId
      ? 'skill'
      : 'runtime';
  const skillId = normalizeOptionalString(options.skillId);
  const skillVersion = normalizeOptionalString(options.skillVersion);

  return {
    name: tool.name,
    source,
    ...(skillId ? { skillId } : {}),
    ...(skillVersion ? { skillVersion } : {}),
    capabilities: normalizeCapabilities(options.capabilities)
  };
}

function normalizeCapabilities(capabilities: readonly string[] | undefined): string[] {
  return [...new Set(
    (capabilities ?? [])
      .filter((capability): capability is string => typeof capability === 'string')
      .map((capability) => capability.trim())
      .filter(Boolean)
  )].sort();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function hasCapabilities(declared: readonly string[], required: readonly string[]): boolean {
  const available = new Set(declared);
  return required.every((capability) => available.has('*') || available.has(capability));
}

function cloneToolRegistrationDescriptor(descriptor: ToolRegistrationDescriptor): ToolRegistrationDescriptor {
  return {
    ...descriptor,
    capabilities: [...descriptor.capabilities]
  };
}
