import { AssistantEventStream } from '@inkpi/ai';
import { TaskRegistry, TaskRouter, ToolRegistry } from '@inkpi/agent-core';
import type { TaskHandlerContext } from '@inkpi/agent-core';
import type { AiTask, AgentMessage, ModelConfig } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { TaskModelHandler } from '@inkpi/server';

const model: ModelConfig = {
  id: 'test-model',
  name: 'Test model',
  provider: 'faux',
};

function task(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'model-task',
    kind: 'test.model',
    input: { text: 'context' },
    outputContract: { format: 'structured' },
    ...overrides,
  };
}

describe('generic model task handler', () => {
  it('executes tool calls through the shared registry and removes private thinking from output', async () => {
    const toolRegistry = new ToolRegistry();
    let toolExecutions = 0;
    toolRegistry.register({
      name: 'lookup',
      description: 'Lookup a value',
      execute: async () => {
        toolExecutions += 1;
        return { content: [{ type: 'text', text: 'tool result' }] };
      },
    });
    let modelCalls = 0;
    const messagesSeen: AgentMessage[][] = [];
    const stream = (_model: ModelConfig, messages: AgentMessage[]) => {
      messagesSeen.push([...messages]);
      const result = new AssistantEventStream();
      queueMicrotask(() => {
        if (modelCalls++ === 0) {
          result.push({ type: 'thinking_delta', thinkingDelta: 'private reasoning' });
          result.push({ type: 'tool_call_start', toolCallId: 'call-1', toolName: 'lookup' });
          result.push({ type: 'tool_call_end', toolCall: { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: {} } });
        } else {
          result.push({ type: 'thinking_delta', thinkingDelta: 'hidden' });
          result.push({ type: 'text_delta', textDelta: '{"answer":"ok"}' });
        }
        result.end();
      });
      return result;
    };
    const registry = new TaskRegistry();
    registry.register(new TaskModelHandler({
      model,
      stream,
      maxToolSteps: 2,
      defaultModelCapabilities: { outputFormats: ['structured'], structuredOutput: true },
    }));
    const router = new TaskRouter({ registry, toolRegistry });

    router.submit(task());
    const result = await router.wait('model-task');

    expect(result).toMatchObject({
      status: 'completed',
      output: { format: 'structured', data: { answer: 'ok' } },
      provenance: {
        toolStepCount: 1,
        toolCalls: [{ id: 'call-1', name: 'lookup', isError: false }],
      },
    });
    expect(toolExecutions).toBe(1);
    expect(messagesSeen).toHaveLength(2);
    expect(messagesSeen[1].some((message) => message.role === 'toolResult')).toBe(true);
  });

  it('fails a tool request explicitly when the registry is unavailable', async () => {
    const stream = (_model: ModelConfig, _messages: AgentMessage[]) => {
      const result = new AssistantEventStream();
      queueMicrotask(() => {
        result.push({ type: 'tool_call_start', toolCallId: 'call-missing', toolName: 'missing' });
        result.push({ type: 'tool_call_end', toolCall: { type: 'toolCall', id: 'call-missing', name: 'missing', arguments: {} } });
        result.end();
      });
      return result;
    };
    const handler = new TaskModelHandler({
      model,
      stream,
      defaultModelCapabilities: { outputFormats: ['structured'], structuredOutput: true },
    });
    const context: TaskHandlerContext = {
      task: task({ id: 'model-no-tools' }),
      context: {
        fragments: [],
        text: '',
        tokenEstimate: 0,
        fingerprint: 'test-context',
        truncated: false,
      },
      signal: new AbortController().signal,
      executionRunId: 'run:model-no-tools',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined,
    };

    await expect(handler.execute(context)).rejects.toThrow('no ToolRegistry');
  });
});
