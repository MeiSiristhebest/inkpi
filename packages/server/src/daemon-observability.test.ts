import { describe, expect, it } from 'vitest';
import type { TaskRunObservation } from '@inkpi/agent-core';
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
      daemon.getTaskRouter().submit({
        id: 'daemon-observability-task',
        kind: 'test.daemon.observability',
        input: {},
        outputContract: { format: 'text' }
      });
      await expect(daemon.getTaskRouter().wait('daemon-observability-task')).resolves.toMatchObject({
        status: 'completed'
      });

      expect(daemon.getTaskObservability().get('daemon-observability-task')).toMatchObject({
        taskId: 'daemon-observability-task',
        status: 'completed',
        cache: {
          context: { misses: 1 }
        }
      });
      expect(daemon.getCacheCoordinator().stats().context.misses).toBe(1);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({ taskId: 'daemon-observability-task', status: 'completed' });
    } finally {
      await daemon.stop();
    }
  });
});
