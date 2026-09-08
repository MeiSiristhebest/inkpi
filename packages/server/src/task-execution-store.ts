import type { TaskExecutionRecord, TaskExecutionStore } from '@inkpi/agent-core';
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
           steering_json = excluded.steering_json`,
      )
      .run(
        record.task.id,
        JSON.stringify(record.task),
        JSON.stringify(record.snapshot),
        record.attempts,
        record.updatedAt,
        record.run ? JSON.stringify(record.run) : null,
        record.steps ? JSON.stringify(record.steps) : null,
        record.executionAttempts ? JSON.stringify(record.executionAttempts) : null,
        record.resumeToken ? JSON.stringify(record.resumeToken) : null,
        record.steering ? JSON.stringify(record.steering) : null,
      );
  }

  load(taskId: string): TaskExecutionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT task_json, snapshot_json, attempts, updated_at,
                run_json, steps_json, execution_attempts_json, resume_token_json, steering_json
         FROM task_executions WHERE task_id = ?`,
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
  return {
    task: JSON.parse(String(row.task_json)),
    snapshot: JSON.parse(String(row.snapshot_json)),
    attempts: Number(row.attempts),
    updatedAt: Number(row.updated_at),
    run: parseJson(row.run_json),
    steps: parseJson(row.steps_json),
    executionAttempts: parseJson(row.execution_attempts_json),
    resumeToken: parseJson(row.resume_token_json),
    steering: parseJson(row.steering_json),
  } as TaskExecutionRecord;
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return undefined;
  return JSON.parse(String(value));
}
