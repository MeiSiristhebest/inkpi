import type { ScheduledTaskState } from '@inkpi/agent-core';
import { InkDb } from '@inkpi/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTaskSchedulerPersistence } from './task-scheduler-persistence.js';

describe('SqliteTaskSchedulerPersistence', () => {
  const dbs: InkDb[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('round-trips queue metadata and Error snapshots', () => {
    const db = new InkDb();
    dbs.push(db);
    const state: ScheduledTaskState = {
      id: 'schedule-1',
      mode: 'background',
      status: 'interrupted',
      attempts: 2,
      readyAt: 42,
      snapshot: {
        id: 'schedule-1',
        mode: 'background',
        status: 'interrupted',
        attempts: 2,
        progress: 0.5,
        error: Object.assign(new Error('stopped'), { name: 'TaskInterruptedError' }),
        checkpoint: { step: 'draft', data: { chapter: 3 }, updatedAt: 41 }
      }
    };
    const store = new SqliteTaskSchedulerPersistence(db, () => 99);

    store.save(state);

    expect(store.load(state.id)).toEqual(state);
    expect(store.list()).toEqual([state]);
    expect(db.prepare('SELECT updated_at FROM task_schedules WHERE id = ?').get(state.id)).toEqual({ updated_at: 99 });
  });

  it('updates a schedule idempotently and rejects corrupt snapshots', () => {
    const db = new InkDb();
    dbs.push(db);
    const store = new SqliteTaskSchedulerPersistence(db);
    const state: ScheduledTaskState = {
      id: 'schedule-2',
      mode: 'foreground',
      status: 'queued',
      attempts: 0,
      readyAt: 1,
      snapshot: { id: 'schedule-2', mode: 'foreground', status: 'queued' }
    };
    store.save(state);
    store.save({ ...state, attempts: 1, readyAt: 2, snapshot: { ...state.snapshot, attempts: 1 } });
    expect(store.list()).toHaveLength(1);
    expect(store.load(state.id)?.attempts).toBe(1);

    db.prepare('UPDATE task_schedules SET snapshot_json = ? WHERE id = ?').run('{bad', state.id);
    expect(() => store.load(state.id)).toThrow("Corrupt scheduled task 'schedule-2' snapshot");
  });
});
