import { type TaskCheckpoint, type TaskCheckpointStore, sanitizePrivateData } from '@inkpi/agent-core';
import type { IDb } from '@inkpi/storage';

/** SQLite-backed checkpoints for daemon restart and crash recovery. */
export class SqliteTaskCheckpointStore implements TaskCheckpointStore {
  constructor(private readonly db: IDb) {}

  save(checkpoint: TaskCheckpoint): void {
    this.db
      .prepare(
        `INSERT INTO task_checkpoints
          (task_id, kind, step, data_json, context_fingerprint, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           kind = excluded.kind,
           step = excluded.step,
           data_json = excluded.data_json,
           context_fingerprint = excluded.context_fingerprint,
           updated_at = excluded.updated_at`
      )
      .run(
        checkpoint.taskId,
        checkpoint.kind,
        checkpoint.step,
        JSON.stringify(sanitizePrivateData(checkpoint.data)),
        checkpoint.contextFingerprint ?? null,
        checkpoint.updatedAt
      );
  }

  load(taskId: string): TaskCheckpoint | undefined {
    const row = this.db
      .prepare(
        `SELECT task_id, kind, step, data_json, context_fingerprint, updated_at
         FROM task_checkpoints WHERE task_id = ?`
      )
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const persistedTaskId = String(row.task_id);
    return {
      taskId: persistedTaskId,
      kind: String(row.kind),
      step: String(row.step),
      data: parsePersistedJson(row.data_json, persistedTaskId, 'data_json'),
      contextFingerprint: row.context_fingerprint == null ? undefined : String(row.context_fingerprint),
      updatedAt: Number(row.updated_at)
    };
  }

  clear(taskId: string): void {
    this.db.prepare('DELETE FROM task_checkpoints WHERE task_id = ?').run(taskId);
  }
}

function parsePersistedJson(value: unknown, taskId: string, field: string): unknown {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Corrupt task checkpoint for '${taskId}' (${field}); refusing to resume`, { cause: error });
  }
}
