import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InkDb } from '@inkpi/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteTaskCheckpointStore } from './task-checkpoint-store.js';

describe('SqliteTaskCheckpointStore', () => {
  const dbs: InkDb[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('round-trips a checkpoint after reopening the SQLite database', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'inkpi-checkpoint-')), 'state.sqlite');
    const firstDb = new InkDb(dbPath);
    const checkpoint = {
      taskId: 'checkpoint-reload',
      kind: 'test.checkpoint',
      step: 'chapter-2',
      data: { next: 3, nested: ['draft', { ok: true }] },
      contextFingerprint: 'ctx-v1',
      updatedAt: 123
    };
    new SqliteTaskCheckpointStore(firstDb).save(checkpoint);
    firstDb.close();

    const reopenedDb = new InkDb(dbPath);
    dbs.push(reopenedDb);
    expect(new SqliteTaskCheckpointStore(reopenedDb).load(checkpoint.taskId)).toEqual(checkpoint);
  });

  it('fails explicitly when checkpoint JSON is corrupt', () => {
    const db = new InkDb();
    dbs.push(db);
    db.prepare(
      `INSERT INTO task_checkpoints (task_id, kind, step, data_json, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run('bad-checkpoint', 'test.corrupt', 'resume', '{broken', 1);

    expect(() => new SqliteTaskCheckpointStore(db).load('bad-checkpoint')).toThrow(
      "Corrupt task checkpoint for 'bad-checkpoint' (data_json); refusing to resume"
    );
  });

  it('removes private reasoning aliases before writing checkpoint JSON', () => {
    const db = new InkDb();
    dbs.push(db);
    const store = new SqliteTaskCheckpointStore(db);
    store.save({
      taskId: 'checkpoint-private-data',
      kind: 'test.checkpoint',
      step: 'draft',
      data: {
        safe: 'keep',
        RAW_COT: 'must not persist',
        nested: { reasoningContent: 'must not persist' }
      },
      updatedAt: 1
    });

    expect(store.load('checkpoint-private-data')?.data).toEqual({ safe: 'keep', nested: {} });
    const row = db
      .prepare('SELECT data_json FROM task_checkpoints WHERE task_id = ?')
      .get('checkpoint-private-data') as { data_json: string };
    expect(row.data_json).not.toContain('must not persist');
  });
});
