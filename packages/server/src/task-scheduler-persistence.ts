import type { ScheduledSnapshot, ScheduledTaskState, TaskSchedulerPersistence } from '@inkpi/agent-core';
import type { IDb } from '@inkpi/storage';

/** SQLite-backed scheduler metadata used to recover durable queue state. */
export class SqliteTaskSchedulerPersistence implements TaskSchedulerPersistence {
  constructor(
    private readonly db: IDb,
    private readonly now: () => number = Date.now
  ) {}

  save(state: ScheduledTaskState): void {
    const snapshotJson = serializeSnapshot(state.snapshot);
    this.db
      .prepare(
        `INSERT INTO task_schedules
          (id, mode, status, snapshot_json, attempts, ready_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          mode = excluded.mode,
          status = excluded.status,
          snapshot_json = excluded.snapshot_json,
          attempts = excluded.attempts,
          ready_at = excluded.ready_at,
          updated_at = excluded.updated_at`
      )
      .run(state.id, state.mode, state.status, snapshotJson, state.attempts, state.readyAt, this.now());
  }

  load(id: string): ScheduledTaskState | undefined {
    const row = this.db
      .prepare(
        `SELECT id, mode, status, snapshot_json, attempts, ready_at
         FROM task_schedules WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;
    return row ? parseState(row) : undefined;
  }

  list(): ScheduledTaskState[] {
    const rows = this.db
      .prepare(
        `SELECT id, mode, status, snapshot_json, attempts, ready_at
         FROM task_schedules ORDER BY updated_at ASC, id ASC`
      )
      .all() as Record<string, unknown>[];
    return rows.map(parseState);
  }
}

function serializeSnapshot(snapshot: ScheduledSnapshot): string {
  try {
    return JSON.stringify({
      ...snapshot,
      error: snapshot.error
        ? {
            name: snapshot.error.name,
            message: snapshot.error.message,
            stack: snapshot.error.stack
          }
        : undefined
    });
  } catch (error) {
    throw new Error('Scheduled task snapshot could not be serialized', { cause: error });
  }
}

function parseState(row: Record<string, unknown>): ScheduledTaskState {
  const id = requiredString(row.id, 'id');
  const mode = requiredString(row.mode, 'mode') as ScheduledTaskState['mode'];
  const status = requiredString(row.status, 'status') as ScheduledTaskState['status'];
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.snapshot_json));
  } catch (error) {
    throw new Error(`Corrupt scheduled task '${id}' snapshot; refusing to recover`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.id !== id) {
    throw new Error(`Scheduled task '${id}' snapshot does not match its record`);
  }
  const snapshot = deserializeSnapshot(parsed, id);
  if (snapshot.mode !== mode || snapshot.status !== status) {
    throw new Error(`Scheduled task '${id}' snapshot metadata does not match its record`);
  }
  return {
    id,
    mode,
    status,
    snapshot,
    attempts: finiteNumber(row.attempts, 'attempts', id),
    readyAt: finiteNumber(row.ready_at, 'ready_at', id)
  };
}

function deserializeSnapshot(value: Record<string, unknown>, id: string): ScheduledSnapshot {
  const snapshot: ScheduledSnapshot = {
    id,
    mode: requiredString(value.mode, 'snapshot.mode') as ScheduledSnapshot['mode'],
    status: requiredString(value.status, 'snapshot.status') as ScheduledSnapshot['status']
  };
  for (const field of ['startedAt', 'finishedAt', 'progress', 'attempts'] as const) {
    const candidate = value[field];
    if (candidate !== undefined) snapshot[field] = finiteNumber(candidate, `snapshot.${field}`, id);
  }
  if (isRecord(value.checkpoint)) {
    const step = requiredString(value.checkpoint.step, 'snapshot.checkpoint.step');
    snapshot.checkpoint = {
      step,
      data: value.checkpoint.data,
      updatedAt:
        value.checkpoint.updatedAt === undefined
          ? undefined
          : finiteNumber(value.checkpoint.updatedAt, 'snapshot.checkpoint.updatedAt', id)
    };
  }
  if (isRecord(value.error)) {
    const error = new Error(requiredString(value.error.message, 'snapshot.error.message'));
    error.name = typeof value.error.name === 'string' ? value.error.name : 'Error';
    if (typeof value.error.stack === 'string') error.stack = value.error.stack;
    snapshot.error = error;
  }
  return snapshot;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Scheduled task ${field} is invalid`);
  return value;
}

function finiteNumber(value: unknown, field: string, id: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) throw new Error(`Scheduled task '${id}' ${field} is invalid`);
  return number;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
