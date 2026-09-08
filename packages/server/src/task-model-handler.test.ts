import type { TaskHandlerContext } from '@inkpi/agent-core';
import { AssistantEventStream, type ModelConfig } from '@inkpi/ai';
import type { AgentMessage, AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { TaskModelHandler } from './task-model-handler.js';

const model: ModelConfig = {
  id: 'structured-failure-model',
  name: 'Structured failure model',
  provider: 'faux'
};

describe('TaskModelHandler structured output failures', () => {
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
      defaultModelCapabilities: { outputFormats: ['structured'], structuredOutput: true }
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
});
