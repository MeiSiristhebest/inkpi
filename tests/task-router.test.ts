import { ContextPipeline, TaskRegistry, TaskRouter, TaskScheduler } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

function task(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'task-router-test',
    kind: 'test.echo',
    input: { text: 'hello' },
    outputContract: { format: 'text' },
    ...overrides
  };
}

describe('TaskRegistry and TaskRouter', () => {
  it('prefers an exact kind handler over an earlier generic fallback', async () => {
    const registry = new TaskRegistry();
    let selected = '';
    registry.register({
      id: 'generic-fallback',
      kinds: ['*'],
      async execute() {
        selected = 'generic';
        return { output: { format: 'text', text: 'generic' } };
      }
    });
    registry.register({
      id: 'exact-handler',
      kinds: ['test.exact'],
      async execute() {
        selected = 'exact';
        return { output: { format: 'text', text: 'exact' } };
      }
    });

    const router = new TaskRouter({ registry });
    router.submit(task({ id: 'exact-task', kind: 'test.exact' }));

    await expect(router.wait('exact-task')).resolves.toMatchObject({ output: { text: 'exact' } });
    expect(selected).toBe('exact');
  });

  it('routes an open task kind through the context pipeline and reports progress', async () => {
    const registry = new TaskRegistry();
    const pipeline = new ContextPipeline();
    pipeline.register({
      id: 'project-context',
      provide: () => [{ id: 'project', source: 'project', text: 'project facts', priority: 10 }]
    });
    let receivedContext = '';
    registry.register({
      id: 'echo-handler',
      kinds: ['test.echo'],
      async execute({ context, reportProgress }) {
        receivedContext = context.text;
        reportProgress(0.5);
        return { output: { format: 'text', text: context.text.toUpperCase() } };
      }
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
      progress: 0.5
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
      }
    });
    const contractRouter = new TaskRouter({ registry });
    contractRouter.submit(task({ id: 'empty-output', kind: 'test.empty', outputContract: { format: 'structured' } }));
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
        })
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
      execute: () => new Promise<never>(() => undefined)
    });
    const timeoutRouter = new TaskRouter({ registry: timeoutRegistry });
    timeoutRouter.submit(
      task({
        id: 'timed-out',
        kind: 'test.slow',
        executionPolicy: { timeoutMs: 5 }
      })
    );
    expect(await timeoutRouter.wait('timed-out')).toMatchObject({
      status: 'failed',
      error: { code: 'TASK_TIMEOUT' }
    });
  });

  it('does not invoke a handler when cancellation wins during context collection', async () => {
    const registry = new TaskRegistry();
    let executed = false;
    registry.register({
      id: 'late-context-handler',
      kinds: ['test.late-context'],
      async execute() {
        executed = true;
        return { output: { format: 'text', text: 'must not run' } };
      }
    });
    let releaseContext!: () => void;
    const context = new ContextPipeline();
    context.register({
      id: 'slow-context',
      provide: () =>
        new Promise((resolve) => {
          releaseContext = () => resolve([{ id: 'late', source: 'test', text: 'late' }]);
        })
    });
    const router = new TaskRouter({ registry, contextPipeline: context });
    router.submit(task({ id: 'late-context-task', kind: 'test.late-context' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.cancel('late-context-task').cancelled).toBe(true);
    releaseContext();

    await expect(router.wait('late-context-task')).resolves.toMatchObject({ status: 'cancelled' });
    expect(executed).toBe(false);
  });

  it('accepts public steering input and records it in the durable execution record', async () => {
    const registry = new TaskRegistry();
    registry.register({
      id: 'steering-handler',
      kinds: ['test.steering'],
      async execute({ consumeSteering }) {
        return { output: { format: 'text', text: JSON.stringify(consumeSteering()) } };
      }
    });
    const router = new TaskRouter({ registry });
    router.submit(task({ id: 'steering-task', kind: 'test.steering' }));
    expect(router.steer('steering-task', { direction: 'more tension' })).toEqual({
      taskId: 'steering-task',
      accepted: true
    });
    await expect(router.wait('steering-task')).resolves.toMatchObject({
      output: { text: '[{"direction":"more tension"}]' }
    });
    expect(router.execution('steering-task').steering).toEqual([]);
  });

  it('applies task scheduling mode and priority through the router', async () => {
    const registry = new TaskRegistry();
    const order: string[] = [];
    let releaseBlocking!: () => void;
    registry.register({
      id: 'scheduled-handler',
      kinds: ['test.scheduled'],
      execute: ({ task }) => {
        order.push(task.id);
        if (task.id === 'blocking') {
          return new Promise((resolve) => {
            releaseBlocking = () => resolve({ output: { format: 'text', text: 'blocking' } });
          });
        }
        return Promise.resolve({ output: { format: 'text', text: task.id } });
      }
    });
    const router = new TaskRouter({
      registry,
      scheduler: new TaskScheduler({ maxForeground: 1 })
    });

    router.submit(
      task({
        id: 'blocking',
        kind: 'test.scheduled',
        executionPolicy: { mode: 'foreground' }
      })
    );
    router.submit(
      task({
        id: 'low',
        kind: 'test.scheduled',
        executionPolicy: { mode: 'foreground', priority: 'low' }
      })
    );
    router.submit(
      task({
        id: 'high',
        kind: 'test.scheduled',
        executionPolicy: { mode: 'foreground', priority: 'high' }
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['blocking']);
    expect(router.status('low').status).toBe('queued');
    expect(router.status('high').status).toBe('queued');

    releaseBlocking();
    await Promise.all([router.wait('blocking'), router.wait('low'), router.wait('high')]);
    expect(order).toEqual(['blocking', 'high', 'low']);
  });
});
