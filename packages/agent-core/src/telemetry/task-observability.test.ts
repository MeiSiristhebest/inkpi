import { describe, expect, it } from 'vitest';
import { TaskObservability, type TaskObservationErrorSignal, type TaskRunObservation } from './task-observability.js';

const task = { id: 'health-task', kind: 'test.health', input: {} };

describe('task observability health boundary', () => {
  it('reports sink failures without changing the task observation path', () => {
    const signals: TaskObservationErrorSignal[] = [];
    const observer = new TaskObservability({
      now: () => 10,
      onObservation: () => {
        throw new Error('sink failure with private details');
      },
      onObservationError: (signal) => signals.push(signal)
    });

    observer.started(task);
    observer.finished(task, {
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      provenance: { publicSummary: 'safe' }
    });

    expect(observer.get(task.id)).toMatchObject({ status: 'completed' });
    expect(observer.getHealth()).toMatchObject({
      healthy: false,
      emitted: 0,
      sinkErrors: 1,
      consecutiveSinkErrors: 1,
      lastErrorAt: 10
    });
    expect(signals).toEqual([
      {
        type: 'observation_sink_error',
        code: 'OBSERVATION_SINK_ERROR',
        at: 10,
        consecutiveFailures: 1
      }
    ]);
    expect(JSON.stringify(signals)).not.toContain('private details');
  });

  it('recovers the consecutive error health signal after a later successful sink call', () => {
    let shouldFail = true;
    const emitted: TaskRunObservation[] = [];
    const observer = new TaskObservability({
      onObservation: (observation) => {
        if (shouldFail) throw new Error('first write failed');
        emitted.push(observation);
      }
    });

    observer.started({ id: 'failed-write', kind: 'test.health', input: {} });
    observer.finished(
      { id: 'failed-write', kind: 'test.health', input: {} },
      {
        taskId: 'failed-write',
        kind: 'test.health',
        status: 'completed',
        provenance: {}
      }
    );
    shouldFail = false;
    observer.started({ id: 'successful-write', kind: 'test.health', input: {} });
    observer.finished(
      { id: 'successful-write', kind: 'test.health', input: {} },
      {
        taskId: 'successful-write',
        kind: 'test.health',
        status: 'completed',
        provenance: {}
      }
    );

    expect(emitted).toHaveLength(1);
    expect(observer.getHealth()).toMatchObject({
      healthy: true,
      emitted: 1,
      sinkErrors: 1,
      consecutiveSinkErrors: 0
    });
  });

  it('removes telemetry payloads and credentials before retaining the observation', () => {
    const observer = new TaskObservability({ now: () => 10 });
    observer.started(task);
    observer.finished(task, {
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      provenance: {
        publicSummary: 'safe',
        input: 'full prompt',
        response: 'full response',
        apiKey: 'secret-value',
        nested: { password: 'nested-secret', tool: 'safe-tool' }
      }
    });

    const observation = observer.get(task.id);
    expect(observation).toMatchObject({ provenance: { publicSummary: 'safe', nested: { tool: 'safe-tool' } } });
    expect(observation?.provenance).not.toHaveProperty('input');
    expect(observation?.provenance).not.toHaveProperty('response');
    expect(JSON.stringify(observation)).not.toContain('secret');
  });
});
