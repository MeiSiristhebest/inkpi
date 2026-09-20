import { ToolRegistry } from '@inkpi/agent-core';
import { type AgentTool, Type } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('ToolRegistry parameter validation', () => {
  it('requires every registered tool to declare an object parameter schema', () => {
    const registry = new ToolRegistry();

    expect(() =>
      registry.register({
        name: 'missing_schema',
        description: 'Missing schema',
        parameters: undefined,
        execute: async () => ({ content: [{ type: 'text', text: 'never' }] })
      })
    ).toThrow(/registration rejected/);

    expect(() =>
      registry.register({
        name: 'unconstrained_schema',
        description: 'Unconstrained schema',
        parameters: Type.Any(),
        execute: async () => ({ content: [{ type: 'text', text: 'never' }] })
      })
    ).toThrow(/unconstrained schema/);
  });

  it('rejects invalid JSON Schema arguments before executing the tool', async () => {
    const registry = new ToolRegistry();
    let executionCount = 0;
    const tool: AgentTool = {
      name: 'structured_tool',
      description: 'Validates structured input',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'options'],
        properties: {
          query: { type: 'string', minLength: 2, pattern: '^[a-z]+$' },
          options: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled'],
            properties: { enabled: { type: 'boolean' } }
          },
          tags: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', enum: ['a', 'b'] }
          }
        }
      },
      execute: async () => {
        executionCount += 1;
        return { content: [{ type: 'text', text: 'executed' }] };
      }
    };
    registry.register(tool);

    const result = await registry.executeTool({
      type: 'toolCall',
      id: 'call-invalid',
      name: tool.name,
      arguments: {
        query: 'A',
        options: { enabled: 'yes' },
        tags: ['unknown'],
        extra: true
      }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('/query String does not match pattern')
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('/options/enabled Expected boolean')
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('/tags[0] Value is not one of the allowed enum values')
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('/extra Unexpected additional property')
    });
    expect(executionCount).toBe(0);
  });

  it('executes a valid JSON Schema argument and preserves the tool result', async () => {
    const registry = new ToolRegistry();
    const tool: AgentTool<{ query: string }> = {
      name: 'echo_structured',
      description: 'Echoes a validated query',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', minLength: 2 },
          limit: { type: 'integer', minimum: 1, maximum: 5 }
        }
      },
      execute: async (_id, args) => ({
        content: [{ type: 'text', text: args.query }],
        details: { limit: 3 }
      })
    };
    registry.register(tool);

    const result = await registry.executeTool({
      type: 'toolCall',
      id: 'call-valid',
      name: tool.name,
      arguments: { query: 'hello', limit: 3 }
    });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(result.details).toEqual({ limit: 3 });
  });

  it('rejects non-JSON arguments before they reach the tool handler', async () => {
    const registry = new ToolRegistry();
    let executionCount = 0;
    const tool: AgentTool = {
      name: 'json_input_tool',
      description: 'Rejects non-JSON input',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        executionCount += 1;
        return { content: [{ type: 'text', text: 'executed' }] };
      }
    };
    registry.register(tool);

    const result = await registry.executeTool({
      type: 'toolCall',
      id: 'call-non-json',
      name: tool.name,
      arguments: { callback: (() => undefined) as unknown }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('/arguments.callback Unsupported JSON value type')
    });
    expect(executionCount).toBe(0);
  });

  it('rejects non-JSON tool result details at the runtime boundary', async () => {
    const registry = new ToolRegistry();
    const tool: AgentTool = {
      name: 'json_output_tool',
      description: 'Rejects non-JSON output details',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({
        content: [{ type: 'text', text: 'executed' }],
        details: { createdAt: new Date() }
      })
    };
    registry.register(tool);

    const result = await registry.executeTool({
      type: 'toolCall',
      id: 'call-non-json-output',
      name: tool.name,
      arguments: {}
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('/details.createdAt Expected a plain JSON object or array')
    });
  });

  it('uses the same complete validation path for TypeBox schemas', async () => {
    const registry = new ToolRegistry();
    const tool: AgentTool = {
      name: 'typebox_tool',
      description: 'Validates TypeBox input',
      parameters: Type.Object({
        count: Type.Integer({ minimum: 1 }),
        enabled: Type.Boolean()
      }),
      execute: async () => ({ content: [{ type: 'text', text: 'executed' }] })
    };
    registry.register(tool);

    const result = await registry.executeTool({
      type: 'toolCall',
      id: 'call-typebox-invalid',
      name: tool.name,
      arguments: { count: '1', enabled: true }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('/count Expected integer')
    });
  });
});
