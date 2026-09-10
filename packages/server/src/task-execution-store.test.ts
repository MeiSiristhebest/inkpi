import type { TaskExecutionRecord } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { InkDb } from '@inkpi/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTaskExecutionStore } from './task-execution-store.js';

describe('SqliteTaskExecutionStore', () => {
  const dbs: InkDb[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('round-trips all execution metadata and keeps old optional fields absent', () => {
    const db = new InkDb();
    dbs.push(db);
    const task = { id: 'execution-round-trip', kind: 'test.execution', input: { value: 7 } } as AiTask;
    const record: TaskExecutionRecord = {
      task,
      snapshot: { taskId: task.id, kind: task.kind, status: 'interrupted', attempts: 2, executionRunId: 'run:1' },
      attempts: 2,
      updatedAt: 20,
      run: { id: 'run:1', taskId: task.id, status: 'interrupted', attempts: 2, updatedAt: 20 },
      steps: [{ id: 'step:1', runId: 'run:1', step: 'draft', status: 'interrupted', startedAt: 10 }],
      executionAttempts: [{ runId: 'run:1', attempt: 2, startedAt: 11, status: 'interrupted' }],
      resumeToken: { taskId: task.id, checkpointStep: 'draft', contextFingerprint: 'ctx', issuedAt: 12 },
      steering: [{ input: 'continue' }]
    };
    const store = new SqliteTaskExecutionStore(db);
    store.save(record);

    expect(store.load(task.id)).toEqual(record);
    expect(store.list()).toEqual([record]);

    db.prepare('UPDATE task_executions SET run_json = NULL, steps_json = NULL WHERE task_id = ?').run(task.id);
    expect(store.load(task.id)).toMatchObject({ task, snapshot: record.snapshot });
    expect(store.load(task.id)?.run).toBeUndefined();
    expect(store.load(task.id)?.steps).toBeUndefined();
  });

  it('fails explicitly on corrupt required or optional JSON', () => {
    const db = new InkDb();
    dbs.push(db);
    db.prepare(
      `INSERT INTO task_executions (task_id, task_json, snapshot_json, attempts, updated_at, run_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('bad-execution', '{bad-task', '{}', 1, 1, null);
    expect(() => new SqliteTaskExecutionStore(db).load('bad-execution')).toThrow(
      "Corrupt task execution 'unknown' (task_json); refusing to recover"
    );

    db.prepare('UPDATE task_executions SET task_json = ?, snapshot_json = ?, run_json = ? WHERE task_id = ?').run(
      JSON.stringify({ id: 'bad-execution', kind: 'test.corrupt', input: {} }),
      '{}',
      '{bad-run',
      'bad-execution'
    );
    expect(() => new SqliteTaskExecutionStore(db).load('bad-execution')).toThrow(
      "Corrupt task execution 'bad-execution' (run_json); refusing to recover"
    );
  });

  it('removes private reasoning aliases from durable errors and provenance', () => {
    const db = new InkDb();
    dbs.push(db);
    const task = { id: 'execution-private-data', kind: 'test.execution', input: {} } as AiTask;
    const error = {
      code: 'TASK_FAILED',
      message: 'failed',
      details: { safe: true, rawCoT: 'must not persist', nested: { THINKING: 'must not persist' } }
    };
    const record: TaskExecutionRecord = {
      task,
      snapshot: {
        taskId: task.id,
        kind: task.kind,
        status: 'failed',
        error,
        result: {
          taskId: task.id,
          kind: task.kind,
          status: 'failed',
          error,
          provenance: { reasoning: 'must not persist' }
        }
      },
      attempts: 1,
      updatedAt: 1,
      steps: [{ id: 'step:1', runId: 'run:1', step: 'draft', status: 'failed', error }],
      executionAttempts: [{ runId: 'run:1', attempt: 1, startedAt: 1, status: 'failed', error }]
    };
    const store = new SqliteTaskExecutionStore(db);
    store.save(record);

    const loaded = store.load(task.id);
    expect(loaded?.snapshot.error?.details).toEqual({ safe: true, nested: {} });
    expect(loaded?.snapshot.result?.provenance).toEqual({});
    expect(loaded?.steps?.[0]?.error?.details).toEqual({ safe: true, nested: {} });
    expect(loaded?.executionAttempts?.[0]?.error?.details).toEqual({ safe: true, nested: {} });
    const row = db
      .prepare('SELECT snapshot_json, steps_json, execution_attempts_json FROM task_executions WHERE task_id = ?')
      .get(task.id) as { snapshot_json: string; steps_json: string; execution_attempts_json: string };
    expect(`${row.snapshot_json}${row.steps_json}${row.execution_attempts_json}`).not.toContain('must not persist');
  });
});
