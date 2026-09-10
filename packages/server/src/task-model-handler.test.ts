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
      defaultModelCapabilities: { outputFormats: ['text'], structuredOutput: true }
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
});
