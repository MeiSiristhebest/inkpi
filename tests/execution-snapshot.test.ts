import { createExecutionSnapshot } from '@inkpi/agent-core';
import type { AgentTool, UserMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

function tool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: 'write_note',
    description: 'Write a note',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...overrides
  };
}

describe('execution snapshots', () => {
  it('captures reproducible route metadata without credentials or executable values', () => {
    const messages: UserMessage[] = [{ id: 'message-1', role: 'user', content: 'Draft a scene' }];
    const snapshot = createExecutionSnapshot({
      id: 'execution-1',
      taskId: 'task-1',
      createdAt: 100,
      model: {
        id: 'gpt-test',
        name: 'Test GPT',
        provider: 'openai',
        baseUrl: 'https://gateway.example.test/v1?api_key=secret',
        apiKey: 'sk-secret',
        fauxScript: { text: 'fixture response' }
      },
      systemPrompt: 'You are a careful editor.',
      thinkingLevel: 'medium',
      tools: [tool({ executionMode: 'sequential', replay: 'never' })],
      messages,
      policy: { allowNetwork: false },
      metadata: { workspaceId: 'workspace-1' }
    });

    expect(snapshot.model).toEqual({
      provider: 'openai',
      modelId: 'gpt-test',
      displayName: 'Test GPT',
      baseUrl: 'https://gateway.example.test/v1',
      thinkingLevel: 'medium'
    });
    expect(snapshot.tools[0]).toMatchObject({
      name: 'write_note',
      executionMode: 'sequential',
      replay: 'never'
    });
    expect(snapshot.context).toMatchObject({
      messageCount: 1,
      messageIds: ['message-1']
    });
    expect(JSON.stringify(snapshot)).not.toContain('sk-secret');
    expect(JSON.stringify(snapshot)).not.toContain('api_key');
    expect(JSON.stringify(snapshot)).not.toContain('execute');
  });

  it('fingerprints message and execution content with deterministic SHA-256', () => {
    const base = {
      id: 'execution-fingerprint',
      createdAt: 100,
      model: { id: 'test', name: 'Test', provider: 'openai' as const },
      systemPrompt: 'System',
      tools: [tool()],
      messages: [{ id: 'same-id', role: 'user' as const, content: 'first' }]
    };
    const first = createExecutionSnapshot(base);
    const second = createExecutionSnapshot({
      ...base,
      messages: [{ id: 'same-id', role: 'user' as const, content: 'second' }]
    });

    expect(first.context.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.context.fingerprint).not.toBe(first.context.fingerprint);
  });

  it('rejects non-JSON tool schemas before a snapshot crosses the boundary', () => {
    expect(() =>
      createExecutionSnapshot({
        id: 'execution-2',
        createdAt: 100,
        model: { id: 'test', name: 'Test', provider: 'openai' },
        systemPrompt: '',
        tools: [tool({ parameters: { invalid: undefined } })],
        messages: []
      })
    ).toThrow(/not JSON-safe/);
  });
});
