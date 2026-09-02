import { validateSchema } from '@inkpi/protocol';
import type { AgentTool, TSchema, ToolCallContent, ToolResult, ToolResultMessage } from '@inkpi/protocol';
import { runWithConcurrency } from './concurrency.js';
import type { ToolExecutionMode } from './types.js';

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  public register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  public get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  public getAll(): AgentTool[] {
    return Array.from(this.tools.values());
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
    onUpdate?: (update: { content: any[]; details?: unknown }) => void,
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
        timestamp: Date.now()
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
        timestamp: Date.now()
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
          timestamp: Date.now()
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
        timestamp: Date.now()
      };
    } catch (err: any) {
      return {
        role: 'toolResult',
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        isError: true,
        content: [{ type: 'text', text: `Tool Exception: ${err?.message || String(err)}` }],
        timestamp: Date.now()
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
