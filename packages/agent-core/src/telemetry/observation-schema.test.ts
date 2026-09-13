import { describe, expect, it } from 'vitest';
import {
  ObservationSchemaError,
  TASK_OBSERVATION_EVENT_TYPE,
  TASK_OBSERVATION_SCHEMA,
  TASK_OBSERVATION_SCHEMA_VERSION,
  isTaskObservationRecord,
  toPersistedTaskObservation
} from './observation-schema.js';

describe('task observation persistence schema', () => {
  it('creates a versioned JSON-safe record without prompt or credential fields', () => {
    const record = toPersistedTaskObservation(
      {
        taskId: 'schema-task',
        kind: 'test.schema',
        status: 'failed',
        error: {
          code: 'PROVIDER_FAILED',
          message: 'api_key=sk-sensitive <think>private chain</think> public failure',
          retryable: true
        },
        provenance: {
          publicSummary: 'safe summary',
          prompt: 'the complete user prompt must not be stored',
          apiKey: 'secret-value',
          executionAttempt: 2,
          executionRunId: 'run-schema-task'
        }
      },
      () => 123
    );

    expect(record).toMatchObject({
      schema: TASK_OBSERVATION_SCHEMA,
      schemaVersion: TASK_OBSERVATION_SCHEMA_VERSION,
      eventType: TASK_OBSERVATION_EVENT_TYPE,
      observedAt: 123,
      taskId: 'schema-task',
      attempt: 2,
      executionRunId: 'run-schema-task',
      provenance: { publicSummary: 'safe summary', executionAttempt: 2 }
    });
    expect(record.provenance).not.toHaveProperty('prompt');
    expect(record.provenance).not.toHaveProperty('apiKey');
    expect(record.error?.message).toBe('[REDACTED]  public failure');
    expect(JSON.stringify(record)).not.toContain('sk-sensitive');
    expect(JSON.stringify(record)).not.toContain('private chain');
    expect(isTaskObservationRecord(record)).toBe(true);
  });

  it('rejects records that cannot satisfy the bounded schema', () => {
    const base = {
      taskId: 'schema-task',
      kind: 'test.schema',
      status: 'completed' as const,
      provenance: {}
    };

    expect(() => toPersistedTaskObservation({ ...base, status: 'unknown' as never })).toThrow(ObservationSchemaError);
    expect(() => toPersistedTaskObservation({ ...base, progress: 2 })).toThrow(/progress/);
    expect(() => toPersistedTaskObservation({ ...base, contextSources: ['selection', 1] as never })).toThrow(
      /contextSources/
    );
  });

  it('turns cycles and bigint values into JSON-safe provenance values', () => {
    const provenance: Record<string, unknown> = { count: BigInt(2) };
    provenance.self = provenance;
    provenance.toJSON = () => ({ leaked: 'must not run' });

    const record = toPersistedTaskObservation({
      taskId: 'schema-safe-values',
      kind: 'test.schema',
      status: 'completed',
      provenance
    });

    expect(record.provenance).toEqual({ count: '2', self: '[Circular]' });
    expect(() => JSON.stringify(record)).not.toThrow();
    expect(JSON.stringify(record)).not.toContain('must not run');
  });
});
