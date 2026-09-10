import { InMemoryTaskCheckpointStore, TaskRegistry, TaskRouter } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('durable task checkpoints', () => {
  it('passes through malformed and unknown checkpoint steps because steps are opaque', async () => {
    const checkpoints = new InMemoryTaskCheckpointStore();
    const task: AiTask = {
      id: 'opaque-checkpoint',
      kind: 'test.opaque-checkpoint',
      input: {},
      outputContract: { format: 'structured' },
    };
    await checkpoints.save({
      taskId: task.id,
      kind: task.kind,
      step: '',
      data: undefined,
      updatedAt: Number.NaN,
    });
    const registry = new TaskRegistry();
    registry.register({
      id: 'opaque-checkpoint-handler',
      kinds: [task.kind],
      async execute({ checkpoint }) {
        return {
          output: {
            format: 'structured',
            data: { step: checkpoint?.step, data: checkpoint?.data, updatedAt: checkpoint?.updatedAt },
          },
        };
      },
    });
    const router = new TaskRouter({ registry, checkpointStore: checkpoints });

    router.submit(task);
    await expect(router.wait(task.id)).resolves.toMatchObject({
      status: 'completed',
      output: { data: { step: '', data: undefined, updatedAt: Number.NaN } },
    });
  });

  it('resumes from an arbitrary workflow step without a step whitelist', async () => {
    const checkpoints = new InMemoryTaskCheckpointStore();
    await checkpoints.save({
      taskId: 'unknown-step',
      kind: 'test.unknown-step',
      step: 'step-added-by-a-new-client',
      data: { value: 7 },
      updatedAt: 1,
    });
    const registry = new TaskRegistry();
    registry.register({
      id: 'unknown-step-handler',
      kinds: ['test.unknown-step'],
      async execute({ checkpoint }) {
        return { output: { format: 'structured', data: checkpoint } };
      },
    });
    const router = new TaskRouter({ registry, checkpointStore: checkpoints });
    router.submit({
      id: 'unknown-step',
      kind: 'test.unknown-step',
      input: {},
      outputContract: { format: 'structured' },
    });

    await expect(router.wait('unknown-step')).resolves.toMatchObject({
      status: 'completed',
      output: { data: { step: 'step-added-by-a-new-client', data: { value: 7 } } },
    });
  });

  it('resumes a task from a checkpoint after the original router fails', async () => {
    const checkpoints = new InMemoryTaskCheckpointStore();
    let attempts = 0;
    const makeRegistry = () => {
      const registry = new TaskRegistry();
      registry.register({
        id: 'resumable-handler',
        kinds: ['test.resumable'],
        async execute({ checkpoint, saveCheckpoint }) {
          attempts += 1;
          if (!checkpoint) {
            await saveCheckpoint('halfway', { value: 42 });
            throw new Error('simulated process failure');
          }
          return { output: { format: 'structured', data: checkpoint.data } };
        }
      });
      return registry;
    };
    const first = new TaskRouter({ registry: makeRegistry(), checkpointStore: checkpoints });
    first.submit({ id: 'resume-me', kind: 'test.resumable', input: {}, outputContract: { format: 'structured' } });
    expect(await first.wait('resume-me')).toMatchObject({ status: 'failed' });
    expect(await checkpoints.load('resume-me')).toMatchObject({ step: 'halfway', data: { value: 42 } });

    const second = new TaskRouter({ registry: makeRegistry(), checkpointStore: checkpoints });
    second.submit({ id: 'resume-me', kind: 'test.resumable', input: {}, outputContract: { format: 'structured' } });
    expect(await second.wait('resume-me')).toMatchObject({
      status: 'completed',
      output: { data: { value: 42 } }
    });
    expect(attempts).toBe(2);
    expect(await checkpoints.load('resume-me')).toBeUndefined();
  });
});
