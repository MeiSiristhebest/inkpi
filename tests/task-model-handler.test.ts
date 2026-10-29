import { SessionCompactor, TaskRegistry, TaskRouter, ToolRegistry } from '@inkpi/agent-core';
import type { SummaryGenerationRequest, TaskHandlerContext } from '@inkpi/agent-core';
import { type ModelConfig as AiModelConfig, AssistantEventStream, type StreamOptions, setHttpClient } from '@inkpi/ai';
import type { AgentMessage, AgentTool, AiTask, ModelConfig } from '@inkpi/protocol';
import { TaskModelHandler } from '@inkpi/server';
import { describe, expect, it } from 'vitest';

const model: ModelConfig = {
  id: 'test-model',
  name: 'Test model',
  provider: 'faux'
};

function task(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'model-task',
    kind: 'test.model',
    input: { text: 'context' },
    outputContract: { format: 'structured' },
    ...overrides
  };
}

describe('generic model task handler', () => {
  it('executes tool calls through the shared registry and removes private thinking from output', async () => {
    const toolRegistry = new ToolRegistry();
    let toolExecutions = 0;
    toolRegistry.register({
      name: 'lookup',
      description: 'Lookup a value',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        toolExecutions += 1;
        return { content: [{ type: 'text', text: 'tool result' }] };
      }
    });
    let modelCalls = 0;
    const messagesSeen: AgentMessage[][] = [];
    const modelsSeen: AiModelConfig[] = [];
    const stream = (dispatchModel: AiModelConfig, messages: AgentMessage[]) => {
      modelsSeen.push(dispatchModel);
      messagesSeen.push([...messages]);
      const result = new AssistantEventStream();
      queueMicrotask(() => {
        if (modelCalls++ === 0) {
          result.push({ type: 'thinking_delta', thinkingDelta: 'private reasoning' });
          result.push({ type: 'tool_call_start', toolCallId: 'call-1', toolName: 'lookup' });
          result.push({
            type: 'tool_call_end',
            toolCall: { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: {} }
          });
        } else {
          result.push({ type: 'thinking_delta', thinkingDelta: 'hidden' });
          result.push({ type: 'text_delta', textDelta: '<think>raw hidden reasoning</think>{"answer":"ok"}' });
        }
        result.end();
      });
      return result;
    };
    const registry = new TaskRegistry();
    registry.register(
      new TaskModelHandler({
        model,
        stream,
        maxToolSteps: 2,
        defaultModelCapabilities: { outputFormats: ['structured'], structuredOutput: true }
      })
    );
    const router = new TaskRouter({ registry, toolRegistry });

    router.submit(task());
    const result = await router.wait('model-task');

    expect(result).toMatchObject({
      status: 'completed',
      output: { format: 'structured', data: { answer: 'ok' } },
      provenance: {
        toolStepCount: 1,
        toolCalls: [{ id: 'call-1', name: 'lookup', isError: false }]
      }
    });
    expect(toolExecutions).toBe(1);
    expect(messagesSeen).toHaveLength(2);
    expect(messagesSeen[1].some((message) => message.role === 'toolResult')).toBe(true);
    expect(modelsSeen).toHaveLength(2);
    expect(modelsSeen[0]).toHaveProperty('routeId', 'default-model');
    expect(modelsSeen[1]).toHaveProperty('routeId', 'default-model');
    expect(messagesSeen[1].find((message) => message.role === 'assistant')).toMatchObject({
      providerSource: {
        provider: 'faux',
        modelId: 'test-model',
        routeId: 'default-model'
      }
    });
  });

  it('passes task and summary-model budgets through the real task compaction call site', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'lookup',
      description: 'Lookup a value',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'lookup result' }] })
    });
    let modelCalls = 0;
    let summaryRequest: SummaryGenerationRequest | undefined;
    const sessionCompactor = new SessionCompactor({
      clock: () => 1,
      preserveRecentCount: 1,
      summaryInputTokens: 80,
      summaryOutputTokens: 12,
      summaryContextWindowTokens: 1_000,
      taskBudgets: {
        'test.summary': {
          summaryInputTokens: 40,
          summaryOutputTokens: 10,
          summaryContextWindowTokens: 900
        }
      },
      summarizer: async (_input, _systemPrompt, request) => {
        summaryRequest = request;
        return {
          text: 'Summary.',
          usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 }
        };
      }
    });
    const stream = (_model: ModelConfig, _messages: AgentMessage[]) => {
      const result = new AssistantEventStream();
      queueMicrotask(() => {
        if (modelCalls++ === 0) {
          result.push({ type: 'tool_call_start', toolCallId: 'call-1', toolName: 'lookup' });
          result.push({
            type: 'tool_call_end',
            toolCall: { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: {} }
          });
        } else {
          result.push({ type: 'text_delta', textDelta: '{"answer":"ok"}' });
        }
        result.end();
      });
      return result;
    };
    const handler = new TaskModelHandler({
      model,
      stream,
      toolRegistry,
      sessionCompactor,
      defaultModelCapabilities: {
        outputFormats: ['structured'],
        structuredOutput: true,
        maxContextTokens: 16,
        maxOutputTokens: 4
      }
    });
    const controller = new AbortController();
    const context: TaskHandlerContext = {
      task: task({
        id: 'model-summary-budget',
        kind: 'test.summary',
        contextPolicy: { maxTokens: 16 }
      }),
      context: {
        fragments: [],
        text: '',
        tokenEstimate: 0,
        fingerprint: 'summary-budget-context',
        truncated: false
      },
      signal: controller.signal,
      executionRunId: 'run:model-summary-budget',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined
    };

    const result = await handler.execute(context);

    expect(result.output).toEqual({ format: 'structured', data: { answer: 'ok' } });
    expect(result.provenance).toMatchObject({
      compactionSummaryUsage: [{ inputTokens: 6, outputTokens: 2, totalTokens: 8 }],
      compactionSummaryBudgets: [
        {
          maxInputTokens: 40,
          estimatedInputTokens: expect.any(Number),
          contextWindowTokens: 900,
          remainingContextTokens: expect.any(Number),
          maxOutputTokens: 10
        }
      ]
    });
    expect(modelCalls).toBe(2);
    expect(summaryRequest).toMatchObject({
      signal: controller.signal,
      maxInputTokens: 40,
      maxOutputTokens: 10,
      contextWindowTokens: 900,
      taskKind: 'test.summary'
    });
  });

  it('fails a tool request explicitly when the registry is unavailable', async () => {
    const stream = (_model: ModelConfig, _messages: AgentMessage[]) => {
      const result = new AssistantEventStream();
      queueMicrotask(() => {
        result.push({ type: 'tool_call_start', toolCallId: 'call-missing', toolName: 'missing' });
        result.push({
          type: 'tool_call_end',
          toolCall: { type: 'toolCall', id: 'call-missing', name: 'missing', arguments: {} }
        });
        result.end();
      });
      return result;
    };
    const handler = new TaskModelHandler({
      model,
      stream,
      defaultModelCapabilities: { outputFormats: ['structured'], structuredOutput: true }
    });
    const context: TaskHandlerContext = {
      task: task({ id: 'model-no-tools' }),
      context: {
        fragments: [],
        text: '',
        tokenEstimate: 0,
        fingerprint: 'test-context',
        truncated: false
      },
      signal: new AbortController().signal,
      executionRunId: 'run:model-no-tools',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined
    };

    await expect(handler.execute(context)).rejects.toThrow('no ToolRegistry');
  });
});

function toolTurn(names: string[] = [], text = '{"answer":"ok"}'): AssistantEventStream {
  const response = new AssistantEventStream();
  for (const name of names) {
    const id = `call-${name}`;
    response.push({ type: 'tool_call_start', toolCallId: id, toolName: name });
    response.push({ type: 'tool_call_end', toolCall: { type: 'toolCall', id, name, arguments: {} } });
  }
  if (names.length === 0) response.push({ type: 'text_delta', textDelta: text });
  response.end();
  return response;
}

function fixtureTool(name: string, execute: AgentTool['execute']): AgentTool {
  return { name, description: name, parameters: { type: 'object', properties: {} }, execute };
}

function modelTaskRouter(
  toolRegistry: ToolRegistry,
  stream: NonNullable<ConstructorParameters<typeof TaskModelHandler>[0]['stream']>
) {
  const registry = new TaskRegistry();
  const handler = new TaskModelHandler({
    model,
    stream,
    defaultModelCapabilities: { tools: true, outputFormats: ['structured'], structuredOutput: true }
  });
  registry.register(handler);
  return new TaskRouter({ registry, toolRegistry });
}

describe('task model hidden-tool boundary', () => {
  it('omits hidden tools from the HTTP payload and rejects guessed calls while preserving host access', async () => {
    const toolRegistry = new ToolRegistry();
    let hiddenExecutions = 0;
    let directExecutions = 0;
    toolRegistry.register(
      fixtureTool('host_only', async () => {
        hiddenExecutions += 1;
        return { content: [{ type: 'text', text: 'host-only result' }] };
      }),
      { exposure: 'hidden' }
    );
    toolRegistry.register(
      fixtureTool('direct', async () => {
        directExecutions += 1;
        return { content: [{ type: 'text', text: 'direct result' }] };
      })
    );
    const requests: Array<{
      tools?: Array<{ function: { name: string } }>;
      messages: Array<{ role: string; tool_call_id?: string; content: string }>;
    }> = [];
    setHttpClient({
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const delta =
          requests.length === 1
            ? {
                tool_calls: ['host_only', 'direct'].map((name, index) => ({
                  index,
                  id: `call-${name}`,
                  type: 'function',
                  function: { name, arguments: '{}' }
                }))
              }
            : { content: '{"answer":"ok"}' };
        const data = { choices: [{ delta, finish_reason: requests.length === 1 ? 'tool_calls' : 'stop' }] };
        return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, { status: 200 });
      }
    });
    try {
      const registry = new TaskRegistry();
      registry.register(
        new TaskModelHandler({
          model: {
            id: 'mock-openai',
            name: 'Mock OpenAI',
            provider: 'openai',
            baseUrl: 'https://provider.test/v1',
            apiKey: 'synthetic-test-key'
          },
          defaultModelCapabilities: { tools: true, outputFormats: ['structured'], structuredOutput: true }
        })
      );
      const router = new TaskRouter({ registry, toolRegistry });
      router.submit(task({ id: 'hidden-wire-task' }));
      const result = await router.wait('hidden-wire-task');

      expect(result.status).toBe('completed');
      expect(requests).toHaveLength(2);
      for (const request of requests) expect(request.tools?.map((tool) => tool.function.name)).toEqual(['direct']);
      expect(requests[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call-host_only',
          content: expect.stringContaining('not available in the current model context')
        })
      );
      expect(hiddenExecutions).toBe(0);
      expect(directExecutions).toBe(1);
      expect(result.provenance).toMatchObject({
        toolCalls: [
          { name: 'host_only', isError: true },
          { name: 'direct', isError: false }
        ]
      });
      expect(toolRegistry.getAll().map((tool) => tool.name)).toEqual(['host_only', 'direct']);
      await expect(
        toolRegistry.executeTool({ type: 'toolCall', id: 'host-call', name: 'host_only', arguments: {} })
      ).resolves.toMatchObject({ isError: false });
      expect(hiddenExecutions).toBe(1);
    } finally {
      setHttpClient(null);
    }
  });

  it('rechecks visibility after a model request starts and before executing the returned call', async () => {
    const toolRegistry = new ToolRegistry();
    let executions = 0;
    const lookup = fixtureTool('lookup', async () => {
      executions += 1;
      return { content: [] };
    });
    toolRegistry.register(lookup);
    const requests: string[][] = [];
    const router = modelTaskRouter(toolRegistry, (_model, _messages, options) => {
      requests.push((options?.tools ?? []).map((tool) => tool.name));
      if (requests.length === 1) {
        toolRegistry.register(lookup, { exposure: 'hidden' });
        return toolTurn(['lookup']);
      }
      return toolTurn();
    });
    router.submit(task({ id: 'revoked-during-model' }));
    const result = await router.wait('revoked-during-model');

    expect(requests).toEqual([['lookup'], []]);
    expect(executions).toBe(0);
    expect(result).toMatchObject({
      status: 'completed',
      provenance: { toolCalls: [{ name: 'lookup', isError: true }] }
    });
  });

  it('rechecks hidden exposure between sequential calls instead of admitting the entire batch', async () => {
    const toolRegistry = new ToolRegistry();
    let executions = 0;
    const later = fixtureTool('later', async () => {
      executions += 1;
      return { content: [] };
    });
    toolRegistry.register(later);
    toolRegistry.register(
      fixtureTool('revoke', async () => {
        await Promise.resolve();
        toolRegistry.register(later, { exposure: 'hidden' });
        return { content: [] };
      })
    );
    let modelCalls = 0;
    const router = modelTaskRouter(toolRegistry, () =>
      modelCalls++ === 0 ? toolTurn(['revoke', 'later']) : toolTurn()
    );
    router.submit(task({ id: 'revoked-during-batch' }));
    const result = await router.wait('revoked-during-batch');

    expect(executions).toBe(0);
    expect(result).toMatchObject({
      status: 'completed',
      provenance: {
        toolCalls: [
          { name: 'revoke', isError: false },
          { name: 'later', isError: true }
        ]
      }
    });
  });

  it('invalidates the provider response identity when a declared tool becomes hidden', async () => {
    const toolRegistry = new ToolRegistry();
    const lookup = fixtureTool('lookup', async () => ({ content: [] }));
    toolRegistry.register(lookup);
    const requests: Array<StreamOptions | undefined> = [];
    const router = modelTaskRouter(toolRegistry, (_model, _messages, options) => {
      requests.push(options);
      return toolTurn([], JSON.stringify({ tools: (options?.tools ?? []).map((tool) => tool.name) }));
    });
    router.submit(task({ id: 'visible-first' }));
    const first = await router.wait('visible-first');
    router.submit(task({ id: 'visible-cached' }));
    const cached = await router.wait('visible-cached');
    expect(first.output).toEqual({ format: 'structured', data: { tools: ['lookup'] } });
    expect(cached.provenance).toMatchObject({ providerCacheHit: true });
    expect(requests).toHaveLength(1);

    toolRegistry.register(lookup, { exposure: 'hidden' });
    router.submit(task({ id: 'hidden-after-cache' }));
    const hidden = await router.wait('hidden-after-cache');
    expect(hidden.output).toEqual({ format: 'structured', data: { tools: [] } });
    expect(hidden.provenance).toMatchObject({ providerCacheHit: false });
    expect(requests).toHaveLength(2);
  });
});
