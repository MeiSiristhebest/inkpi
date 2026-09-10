import { type TaskExecutionRecord, type TaskExecutionStore, sanitizePrivateData } from '@inkpi/agent-core';
import type { IDb } from '@inkpi/storage';

/** SQLite-backed task records used to recover interrupted runs after daemon restart. */
export class SqliteTaskExecutionStore implements TaskExecutionStore {
  constructor(private readonly db: IDb) {}

  save(record: TaskExecutionRecord): void {
    this.db
      .prepare(
        `INSERT INTO task_executions
          (task_id, task_json, snapshot_json, attempts, updated_at,
           run_json, steps_json, execution_attempts_json, resume_token_json, steering_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           task_json = excluded.task_json,
           snapshot_json = excluded.snapshot_json,
           attempts = excluded.attempts,
           updated_at = excluded.updated_at,
           run_json = excluded.run_json,
           steps_json = excluded.steps_json,
           execution_attempts_json = excluded.execution_attempts_json,
           resume_token_json = excluded.resume_token_json,
           steering_json = excluded.steering_json`
      )
      .run(
        record.task.id,
        JSON.stringify(record.task),
        JSON.stringify(sanitizePrivateData(record.snapshot)),
        record.attempts,
        record.updatedAt,
        record.run ? JSON.stringify(record.run) : null,
        record.steps ? JSON.stringify(sanitizePrivateData(record.steps)) : null,
        record.executionAttempts ? JSON.stringify(sanitizePrivateData(record.executionAttempts)) : null,
        record.resumeToken ? JSON.stringify(record.resumeToken) : null,
        record.steering ? JSON.stringify(record.steering) : null
      );
  }

  load(taskId: string): TaskExecutionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT task_json, snapshot_json, attempts, updated_at,
                run_json, steps_json, execution_attempts_json, resume_token_json, steering_json
         FROM task_executions WHERE task_id = ?`
      )
      .get(taskId) as Record<string, unknown> | undefined;
    return row ? parseRecord(row) : undefined;
  }

  list(): TaskExecutionRecord[] {
    const rows = this.db
      .prepare(`SELECT task_json, snapshot_json, attempts, updated_at,
                       run_json, steps_json, execution_attempts_json, resume_token_json, steering_json
                FROM task_executions ORDER BY updated_at, task_id`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(parseRecord);
  }
}

function parseRecord(row: Record<string, unknown>): TaskExecutionRecord {
  const task = parsePersistedJson(row.task_json, 'unknown', 'task_json');
  const taskId = task && typeof task === 'object' && 'id' in task ? String(task.id) : 'unknown';
  return {
    task: task as TaskExecutionRecord['task'],
    snapshot: parsePersistedJson(row.snapshot_json, taskId, 'snapshot_json') as TaskExecutionRecord['snapshot'],
    attempts: Number(row.attempts),
    updatedAt: Number(row.updated_at),
    run: parseJson(row.run_json, taskId, 'run_json'),
    steps: parseJson(row.steps_json, taskId, 'steps_json'),
    executionAttempts: parseJson(row.execution_attempts_json, taskId, 'execution_attempts_json'),
    resumeToken: parseJson(row.resume_token_json, taskId, 'resume_token_json'),
    steering: parseJson(row.steering_json, taskId, 'steering_json')
  } as TaskExecutionRecord;
}

function parsePersistedJson(value: unknown, taskId: string, field: string): unknown {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Corrupt task execution '${taskId}' (${field}); refusing to recover`, { cause: error });
  }
}

function parseJson(value: unknown, taskId: string, field: string): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  return parsePersistedJson(value, taskId, field);
}
