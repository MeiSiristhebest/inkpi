import { TaskRegistry, TaskRouter } from '@inkpi/agent-core';
import { AssistantEventStream, type ModelConfig, createFauxProvider } from '@inkpi/ai';
import type { AiTask } from '@inkpi/protocol';
import { TaskModelHandler } from '@inkpi/server';
import { describe, expect, it } from 'vitest';

const model: ModelConfig = { id: 'fixture-model', name: 'Fixture model', provider: 'faux' };

function task(id: string, format: 'text' | 'structured' = 'text'): AiTask {
  return {
    id,
    kind: 'test.provider-fallback',
    input: { text: 'provider failover input' },
    outputContract: { format },
    requirements: { capabilities: ['creative-writing'], outputFormats: [format] },
    executionPolicy: { maxAttempts: 1 }
  };
}

function unavailableStream() {
  const stream = new AssistantEventStream();
  queueMicrotask(() => stream.error('provider unavailable'));
  return stream;
}

function registryFor(routes: ConstructorParameters<typeof TaskModelHandler>[0]): TaskRouter {
  const registry = new TaskRegistry();
  registry.register(new TaskModelHandler(routes));
  return new TaskRouter({ registry });
}

describe('capability route availability failover', () => {
  it('tries the next compatible route after a retryable provider failure', async () => {
    const calls: string[] = [];
    const router = registryFor({
      routes: [
        {
          id: 'primary',
          model,
          priority: 10,
          stream: () => {
            calls.push('primary');
            return unavailableStream();
          },
          capabilities: { capabilities: ['*'], outputFormats: ['text'], streaming: true }
        },
        {
          id: 'backup',
          model: { ...model, id: 'backup-model' },
          fallback: true,
          stream: () => {
            calls.push('backup');
            return createFauxProvider({ text: 'backup response' })(model, []);
          },
          capabilities: { capabilities: ['*'], outputFormats: ['text'], streaming: true }
        }
      ]
    });

    const result = await router.wait(router.submit(task('provider-fallback')).taskId);

    expect(result).toMatchObject({
      status: 'completed',
      output: { format: 'text', text: 'backup response' },
      provenance: { routeId: 'backup', routeAttempts: ['primary', 'backup'] }
    });
    expect(calls).toEqual(['primary', 'backup']);
  });

  it('does not fail over deterministic invalid output', async () => {
    const calls: string[] = [];
    const router = registryFor({
      routes: [
        {
          id: 'invalid-output',
          model,
          priority: 10,
          stream: () => {
            calls.push('invalid-output');
            return createFauxProvider({ text: 'not json' })(model, []);
          },
          capabilities: { capabilities: ['*'], outputFormats: ['structured'], streaming: true }
        },
        {
          id: 'should-not-run',
          model: { ...model, id: 'unused-model' },
          fallback: true,
          stream: () => {
            calls.push('should-not-run');
            return createFauxProvider({ text: '{}' })(model, []);
          },
          capabilities: { capabilities: ['*'], outputFormats: ['structured'], streaming: true }
        }
      ]
    });

    const result = await router.wait(router.submit(task('invalid-output', 'structured')).taskId);

    expect(result).toMatchObject({ status: 'failed', error: { message: 'Model output is not valid JSON' } });
    expect(calls).toEqual(['invalid-output']);
  });
});
