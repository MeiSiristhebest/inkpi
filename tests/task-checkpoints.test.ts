import { describe, expect, it } from 'vitest';
import { InMemoryTaskCheckpointStore, TaskRegistry, TaskRouter } from '@inkpi/agent-core';

describe('durable task checkpoints', () => {
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
        },
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
      output: { data: { value: 42 } },
    });
    expect(attempts).toBe(2);
    expect(await checkpoints.load('resume-me')).toBeUndefined();
  });
});
