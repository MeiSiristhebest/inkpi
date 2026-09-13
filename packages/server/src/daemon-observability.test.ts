import type { TaskRunObservation } from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';
import { InkPiDaemon } from './daemon.js';

describe('InkPiDaemon observability defaults', () => {
  it('attaches sampled observations to the default task path with cache stats', async () => {
    const emitted: TaskRunObservation[] = [];
    const daemon = new InkPiDaemon({
      observability: {
        sampleRate: 1,
        random: () => 0,
        onObservation: (observation) => emitted.push(observation)
      }
    });
    daemon.getTaskRouter().registry.register({
      id: 'daemon-observability-fixture',
      kinds: ['test.daemon.observability'],
      async execute() {
        return { output: { format: 'text', text: 'ok' } };
      }
    });

    try {
      const submitTask = (id: string) => {
        daemon.getTaskRouter().submit({
          id,
          kind: 'test.daemon.observability',
          input: {},
          outputContract: { format: 'text' }
        });
        return daemon.getTaskRouter().wait(id);
      };
      await expect(submitTask('daemon-observability-task-miss')).resolves.toMatchObject({ status: 'completed' });
      await expect(submitTask('daemon-observability-task-hit')).resolves.toMatchObject({ status: 'completed' });

      expect(daemon.getTaskObservability().get('daemon-observability-task-miss')).toMatchObject({
        taskId: 'daemon-observability-task-miss',
        status: 'completed',
        cache: {
          context: { misses: 1 }
        }
      });
      expect(daemon.getTaskObservability().get('daemon-observability-task-hit')).toMatchObject({
        taskId: 'daemon-observability-task-hit',
        status: 'completed',
        cache: {
          context: { hits: 1, misses: 0 }
        }
      });
      expect(daemon.getCacheCoordinator().stats().context).toMatchObject({ hits: 1, misses: 1 });
      expect(emitted).toHaveLength(2);
      expect(emitted.map((observation) => observation.taskId)).toEqual([
        'daemon-observability-task-miss',
        'daemon-observability-task-hit'
      ]);
    } finally {
      await daemon.stop();
    }
  });
});
