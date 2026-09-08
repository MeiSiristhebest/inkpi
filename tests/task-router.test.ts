import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { ContextPipeline, TaskRegistry, TaskRouter } from '@inkpi/agent-core';

function task(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'task-router-test',
    kind: 'test.echo',
    input: { text: 'hello' },
    outputContract: { format: 'text' },
    ...overrides,
  };
}

describe('TaskRegistry and TaskRouter', () => {
  it('routes an open task kind through the context pipeline and reports progress', async () => {
    const registry = new TaskRegistry();
    const pipeline = new ContextPipeline();
    pipeline.register({
      id: 'project-context',
      provide: () => [{ id: 'project', source: 'project', text: 'project facts', priority: 10 }],
    });
    let receivedContext = '';
    registry.register({
      id: 'echo-handler',
      kinds: ['test.echo'],
      async execute({ context, reportProgress }) {
        receivedContext = context.text;
        reportProgress(0.5);
        return { output: { format: 'text', text: context.text.toUpperCase() } };
      },
    });
    const events: string[] = [];
    const router = new TaskRouter({ registry, contextPipeline: pipeline });
    router.subscribe((event) => {
      events.push(event.type);
    });

    expect(router.submit(task())).toEqual({ taskId: 'task-router-test', status: 'queued' });
    const result = await router.wait('task-router-test');

    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ format: 'text', text: 'HELLO\n\nPROJECT FACTS' });
    expect(receivedContext).toBe('hello\n\nproject facts');
    expect(router.status('task-router-test')).toMatchObject({
      status: 'completed',
      progress: 0.5,
    });
    expect(events).toEqual(['created', 'queued', 'started', 'progress', 'completed']);
  });

  it('fails loudly when no handler or output contract is available', async () => {
    const router = new TaskRouter();
    router.submit(task({ id: 'missing-handler' }));
    const missing = await router.wait('missing-handler');
    expect(missing).toMatchObject({ status: 'failed', error: { code: 'TASK_FAILED' } });
    expect(missing.error?.message).toContain('No task handler');

    const registry = new TaskRegistry();
    registry.register({
      id: 'empty-handler',
      kinds: ['test.empty'],
      async execute() {
        return {};
      },
    });
    const contractRouter = new TaskRouter({ registry });
    contractRouter.submit(
      task({ id: 'empty-output', kind: 'test.empty', outputContract: { format: 'structured' } }),
    );
    const empty = await contractRouter.wait('empty-output');
    expect(empty).toMatchObject({ status: 'failed', error: { code: 'MISSING_OUTPUT' } });
  });

  it('cancels an in-flight handler and reports timeout separately', async () => {
    const registry = new TaskRegistry();
    registry.register({
      id: 'blocking-handler',
      kinds: ['test.blocking'],
      execute: ({ signal }) =>
        new Promise<never>((_, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });
    const router = new TaskRouter({ registry });
    router.submit(task({ id: 'cancelled', kind: 'test.blocking' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.cancel('cancelled').cancelled).toBe(true);
    expect(await router.wait('cancelled')).toMatchObject({ status: 'cancelled' });

    const timeoutRegistry = new TaskRegistry();
    timeoutRegistry.register({
      id: 'slow-handler',
      kinds: ['test.slow'],
      execute: () => new Promise<never>(() => undefined),
    });
    const timeoutRouter = new TaskRouter({ registry: timeoutRegistry });
    timeoutRouter.submit(
      task({
        id: 'timed-out',
        kind: 'test.slow',
        executionPolicy: { timeoutMs: 5 },
      }),
    );
    expect(await timeoutRouter.wait('timed-out')).toMatchObject({
      status: 'failed',
      error: { code: 'TASK_TIMEOUT' },
    });
  });

  it('accepts public steering input and records it in the durable execution record', async () => {
    const registry = new TaskRegistry();
    registry.register({
      id: 'steering-handler',
      kinds: ['test.steering'],
      async execute({ consumeSteering }) {
        return { output: { format: 'text', text: JSON.stringify(consumeSteering()) } };
      },
    });
    const router = new TaskRouter({ registry });
    router.submit(task({ id: 'steering-task', kind: 'test.steering' }));
    expect(router.steer('steering-task', { direction: 'more tension' })).toEqual({
      taskId: 'steering-task',
      accepted: true,
    });
    await expect(router.wait('steering-task')).resolves.toMatchObject({
      output: { text: '[{"direction":"more tension"}]' },
    });
    expect(router.execution('steering-task').steering).toEqual([]);
  });
});
