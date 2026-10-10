import type { TaskHandlerContext } from '@inkpi/agent-core';
import { ToolRegistry } from '@inkpi/agent-core';
import { AssistantEventStream, type ModelConfig, type StreamOptions } from '@inkpi/ai';
import type { AgentMessage, AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { TaskModelHandler } from './task-model-handler.js';

const model: ModelConfig = {
  id: 'structured-failure-model',
  name: 'Structured failure model',
  provider: 'faux'
};

describe('TaskModelHandler structured output failures', () => {
  it('resolves broker credentials only for the provider call and keeps them out of the execution snapshot', async () => {
    let providerModel: ModelConfig | undefined;
    const handler = new TaskModelHandler({
      routes: [
        {
          id: 'credential-route',
          model: { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
          credentialRef: 'inkpi.model.openai.gpt-4o',
          capabilities: { outputFormats: ['text'], structuredOutput: true }
        }
      ],
      credentialResolver: async (reference) => {
        expect(reference).toBe('inkpi.model.openai.gpt-4o');
        return 'broker-secret';
      },
      stream: (modelForProvider) => {
        providerModel = modelForProvider;
        const result = new AssistantEventStream();
        queueMicrotask(() => {
          result.push({ type: 'text_delta', textDelta: 'answer' });
          result.end();
        });
        return result;
      }
    });

    const result = await handler.execute({
      task: {
        id: 'credential-task',
        kind: 'test.credential',
        input: {},
        outputContract: { format: 'text' }
      },
      context: {
        fragments: [],
        text: '',
        tokenEstimate: 0,
        fingerprint: 'credential-context',
        truncated: false
      },
      signal: new AbortController().signal,
      executionRunId: 'run:credential-task',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined
    });

    const snapshot = result.executionSnapshot;
    expect(providerModel?.apiKey).toBe('broker-secret');
    expect(snapshot?.model).not.toHaveProperty('apiKey');
    expect(JSON.stringify(snapshot)).not.toContain('broker-secret');
  });

  it('fails closed when a referenced credential has no broker', async () => {
    const handler = new TaskModelHandler({
      routes: [
        {
          id: 'credential-route',
          model: { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
          credentialRef: 'inkpi.model.openai.gpt-4o'
        }
      ]
    });

    await expect(
      handler.execute({
        task: {
          id: 'credential-no-broker-task',
          kind: 'test.credential',
          input: {}
        },
        context: {
          fragments: [],
          text: '',
          tokenEstimate: 0,
          fingerprint: 'credential-context',
          truncated: false
        },
        signal: new AbortController().signal,
        executionRunId: 'run:credential-no-broker-task',
        attempt: 1,
        consumeSteering: () => [],
        saveCheckpoint: async () => undefined,
        reportProgress: () => undefined
      })
    ).rejects.toThrow('Model credential broker is not configured');
  });

  it('rejects invalid structured output with a non-retryable error', async () => {
    const stream = (_model: ModelConfig, _messages: AgentMessage[]) => {
      const result = new AssistantEventStream();
      queueMicrotask(() => {
        result.push({ type: 'text_delta', textDelta: '{not-json}' });
        result.end();
      });
      return result;
    };
    const handler = new TaskModelHandler({
      model,
      stream,
      defaultModelCapabilities: {
        outputFormats: ['structured'],
        structuredOutput: true
      }
    });
    const task: AiTask = {
      id: 'structured-failure-task',
      kind: 'test.structured-failure',
      input: {},
      outputContract: { format: 'structured' }
    };
    const context: TaskHandlerContext = {
      task,
      context: {
        fragments: [],
        text: '',
        tokenEstimate: 0,
        fingerprint: 'structured-failure-context',
        truncated: false
      },
      signal: new AbortController().signal,
      executionRunId: 'run:structured-failure-task',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined
    };

    await expect(handler.execute(context)).rejects.toMatchObject({
      message: 'Model output is not valid JSON',
      retryable: false
    });
  });

  it('assembles the prompt in the stable runtime-to-intent order without duplicating compiled context', async () => {
    let prompt = '';
    const stream = (_model: ModelConfig, messages: AgentMessage[]) => {
      prompt = String(messages[0]?.content ?? '');
      const result = new AssistantEventStream();
      queueMicrotask(() => {
        result.push({ type: 'text_delta', textDelta: 'answer' });
        result.end();
      });
      return result;
    };
    const handler = new TaskModelHandler({
      model,
      stream,
      defaultModelCapabilities: {
        outputFormats: ['text'],
        structuredOutput: true
      }
    });
    const task: AiTask = {
      id: 'prompt-order-task',
      kind: 'creative.continue',
      input: {
        payload: {
          context: { compiled: 'must appear through providers only' },
          goal: 'TASK_DETAILS'
        }
      },
      intent: 'USER_INTENT',
      outputContract: { format: 'text' }
    };

    await handler.execute({
      task,
      context: {
        fragments: [
          { id: 'retrieved', source: 'retrieval.jit', text: 'RETRIEVED' },
          { id: 'scene', source: 'creative.document', text: 'SCENE' },
          { id: 'project', source: 'creative.story', text: 'PROJECT' }
        ],
        text: 'RETRIEVED\n\nSCENE\n\nPROJECT',
        tokenEstimate: 3,
        fingerprint: 'prompt-order-context',
        truncated: false,
        projectRevision: 4
      },
      instructions: {
        text: 'SKILL_INSTRUCTION',
        entryIds: ['skill.prompt-order'],
        truncated: false,
        version: 'instructions-1'
      },
      signal: new AbortController().signal,
      executionRunId: 'run:prompt-order-task',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined
    });

    const order = [
      'Runtime instruction:',
      'Stable skill instruction:',
      'Stable project context:',
      'Retrieved context:',
      'Current scene / selection:',
      'Task details:',
      'User intent:'
    ].map((section) => prompt.indexOf(section));
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(prompt.indexOf('PROJECT')).toBeLessThan(prompt.indexOf('RETRIEVED'));
    expect(prompt.indexOf('RETRIEVED')).toBeLessThan(prompt.indexOf('SCENE'));
    expect(prompt).toContain('TASK_DETAILS');
    expect(prompt).toContain('USER_INTENT');
    expect(prompt).not.toContain('must appear through providers only');
  });

  it('uses provider-backed conversation history once instead of repeating it in task details', async () => {
    let prompt = '';
    const handler = new TaskModelHandler({
      model,
      stream: (_model, messages) => {
        prompt = String(messages[0]?.content ?? '');
        const result = new AssistantEventStream();
        queueMicrotask(() => {
          result.push({ type: 'text_delta', textDelta: 'answer' });
          result.end();
        });
        return result;
      },
      defaultModelCapabilities: { outputFormats: ['text'] }
    });
    const task: AiTask = {
      id: 'history-prompt-task',
      kind: 'creative.assistant',
      input: {
        payload: {
          conversationHistory: [
            { role: 'user', text: 'earlier-user-history-marker' },
            { role: 'assistant', text: 'earlier-assistant-history-marker' }
          ],
          question: 'current question'
        }
      },
      outputContract: { format: 'text' }
    };

    await handler.execute({
      task,
      context: {
        fragments: [
          {
            id: 'conversation-history',
            source: 'creative.conversation-history',
            kind: 'conversation-history',
            data: {
              turns: [
                { role: 'user', text: 'earlier-user-history-marker' },
                { role: 'assistant', text: 'earlier-assistant-history-marker' }
              ]
            }
          }
        ],
        text: '',
        tokenEstimate: 0,
        fingerprint: 'history-prompt-context',
        truncated: false
      },
      signal: new AbortController().signal,
      executionRunId: 'run:history-prompt-task',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined
    });

    expect(prompt.match(/earlier-user-history-marker/g)).toHaveLength(1);
    expect(prompt.match(/earlier-assistant-history-marker/g)).toHaveLength(1);
    expect(prompt).not.toContain('conversationHistory');
    expect(prompt).toContain('current question');
  });

  it('returns a secret-free execution snapshot for the selected route', async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'lookup',
      description: 'Lookup',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({
        content: [{ type: 'text', text: 'tool value' }]
      })
    });
    const handler = new TaskModelHandler({
      model: {
        ...model,
        baseUrl: 'https://gateway.example.test/v1?api_key=secret',
        apiKey: 'sk-secret'
      },
      toolRegistry,
      stream: (_model, _messages) => {
        const result = new AssistantEventStream();
        queueMicrotask(() => {
          result.push({ type: 'text_delta', textDelta: 'answer' });
          result.end();
        });
        return result;
      },
      defaultModelCapabilities: {
        outputFormats: ['text'],
        structuredOutput: true
      }
    });

    const result = await handler.execute({
      task: {
        id: 'snapshot-task',
        kind: 'test.snapshot',
        input: {},
        executionPolicy: { timeoutMs: 1000, maxAttempts: 2 },
        outputContract: { format: 'text' }
      },
      context: {
        fragments: [],
        text: '',
        tokenEstimate: 4,
        fingerprint: 'snapshot-context',
        truncated: false
      },
      signal: new AbortController().signal,
      executionRunId: 'run:snapshot-task',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined
    });

    expect(result.executionSnapshot).toMatchObject({
      version: 1,
      taskId: 'snapshot-task',
      model: {
        provider: 'faux',
        modelId: 'structured-failure-model',
        baseUrl: 'https://gateway.example.test/v1'
      },
      context: { estimatedTokens: 4, fingerprint: 'f7dc67e4' },
      policy: { timeoutMs: 1000, maxAttempts: 2 },
      metadata: {
        routeId: 'default-model',
        contextFingerprint: 'snapshot-context'
      }
    });
    expect(JSON.stringify(result.executionSnapshot)).not.toContain('sk-secret');
  });

  it('does not send tool schemas when the selected route disables tools', async () => {
    let observedTools: StreamOptions['tools'];
    const toolRegistry = new ToolRegistry();
    toolRegistry.register({
      name: 'lookup',
      description: 'Lookup',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({
        content: [{ type: 'text', text: 'tool value' }]
      })
    });
    const stream = (_model: ModelConfig, _messages: AgentMessage[], options?: StreamOptions) => {
      observedTools = options?.tools;
      const result = new AssistantEventStream();
      queueMicrotask(() => {
        result.push({ type: 'text_delta', textDelta: 'answer' });
        result.end();
      });
      return result;
    };
    const handler = new TaskModelHandler({
      model,
      toolRegistry,
      stream,
      defaultModelCapabilities: {
        outputFormats: ['text'],
        structuredOutput: true,
        tools: false,
        toolCalling: false
      }
    });

    await handler.execute({
      task: {
        id: 'tools-disabled-task',
        kind: 'test.tools-disabled',
        input: {},
        outputContract: { format: 'text' }
      },
      context: {
        fragments: [],
        text: '',
        tokenEstimate: 0,
        fingerprint: 'tools-disabled-context',
        truncated: false
      },
      signal: new AbortController().signal,
      executionRunId: 'run:tools-disabled-task',
      attempt: 1,
      consumeSteering: () => [],
      saveCheckpoint: async () => undefined,
      reportProgress: () => undefined
    });

    expect(observedTools).toBeUndefined();
  });
});
