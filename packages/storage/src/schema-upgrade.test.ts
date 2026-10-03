import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InkDb } from './db.js';
import { InkRepository } from './repository.js';

function insertLegacyArtifact(db: InkDb, id: string, taskId: string): void {
  db.prepare(
    `INSERT INTO artifacts (id, type, task_id, version, content_json, provenance_json, created_at, updated_at, artifact_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    'narrative.continuity.audit',
    taskId,
    1,
    '{"findings":[]}',
    `{"taskId":"${taskId}"}`,
    100,
    100,
    '{"id":"x"}'
  );
}

function columnsOf(db: InkDb, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
}

function indexOf(db: InkDb, name: string): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").all(name) as Array<{ name: string }>
  ).map((r) => r.name);
}

function countRows(db: InkDb, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'inkpi-schema-upgrade-')), 'state.sqlite');
}

describe('schema upgrade of pre-existing databases', () => {
  it('upgrades a database whose artifacts table predates workspace_id', () => {
    const path = tempDbPath();

    const created = new InkDb(path);
    insertLegacyArtifact(created, 'artifact-1', 'task-1');
    insertLegacyArtifact(created, 'artifact-2', 'task-2');
    // Rewind the on-disk shape to what an older build left behind: the column
    // and the index that references it both disappear.
    created.exec('DROP INDEX IF EXISTS idx_artifacts_workspace');
    created.exec('ALTER TABLE artifacts DROP COLUMN workspace_id');
    expect(columnsOf(created, 'artifacts')).not.toContain('workspace_id');
    created.close();

    // Reopening is what the daemon does on every start, so this has to migrate
    // rather than throw out of STORAGE_SCHEMA_DDL.
    const upgraded = new InkDb(path);
    expect(columnsOf(upgraded, 'artifacts')).toContain('workspace_id');
    expect(indexOf(upgraded, 'idx_artifacts_workspace')).toContain('idx_artifacts_workspace');
    expect(countRows(upgraded, 'SELECT COUNT(*) AS n FROM artifacts')).toBe(2);

    // The backfilled column has no source data to recover, so scoping queries
    // must keep treating those rows as unscoped instead of hiding them.
    insertLegacyArtifact(upgraded, 'artifact-3', 'task-3');
    upgraded.prepare('UPDATE artifacts SET workspace_id = ? WHERE id = ?').run('ws-1', 'artifact-3');
    const scoped = (
      upgraded.prepare('SELECT id FROM artifacts WHERE workspace_id = ?').all('ws-1') as Array<{ id: string }>
    ).map((r) => r.id);
    expect(scoped).toEqual(['artifact-3']);
    expect(countRows(upgraded, 'SELECT COUNT(*) AS n FROM artifacts WHERE workspace_id IS NULL')).toBe(2);
    upgraded.close();
  });

  it('re-running the migration is idempotent', () => {
    const path = tempDbPath();
    const db = new InkDb(path);
    insertLegacyArtifact(db, 'artifact-1', 'task-1');
    const before = columnsOf(db, 'artifacts');
    db.initSchema();
    db.initSchema();
    expect(columnsOf(db, 'artifacts')).toEqual(before);
    expect(countRows(db, 'SELECT COUNT(*) AS n FROM artifacts')).toBe(1);
    db.close();
  });

  it('opens databases with legacy execution-plan columns without altering their data', () => {
    const path = tempDbPath();
    const created = new InkDb(path);
    expect(columnsOf(created, 'operations')).not.toContain('plan_json');
    expect(columnsOf(created, 'task_executions')).not.toContain('execution_plan_json');
    expect(columnsOf(created, 'task_executions')).not.toContain('execution_settlement_json');

    created.exec('ALTER TABLE operations ADD COLUMN plan_json TEXT');
    created.exec('ALTER TABLE task_executions ADD COLUMN execution_plan_json TEXT');
    created.exec('ALTER TABLE task_executions ADD COLUMN execution_settlement_json TEXT');
    created
      .prepare(
        `INSERT INTO operations
          (id, session_id, type, state, intent_json, plan_json, settlement_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'operation-1',
        'session-1',
        'tool_call',
        'settled',
        '{"name":"read"}',
        '{"legacy":"plan"}',
        '{"ok":true}',
        1,
        2
      );
    created
      .prepare(
        `INSERT INTO task_executions
          (task_id, task_json, snapshot_json, attempts, updated_at, execution_plan_json, execution_settlement_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run('task-1', '{"id":"task-1"}', '{"status":"interrupted"}', 1, 2, '{"legacy":"plan"}', '{"ok":true}');
    created.close();

    const upgraded = new InkDb(path);
    expect(columnsOf(upgraded, 'operations')).toContain('plan_json');
    expect(columnsOf(upgraded, 'task_executions')).toContain('execution_plan_json');
    expect(columnsOf(upgraded, 'task_executions')).toContain('execution_settlement_json');
    expect(upgraded.prepare('SELECT plan_json FROM operations WHERE id = ?').get('operation-1')).toEqual({
      plan_json: '{"legacy":"plan"}'
    });
    expect(
      upgraded
        .prepare('SELECT execution_plan_json, execution_settlement_json FROM task_executions WHERE task_id = ?')
        .get('task-1')
    ).toEqual({ execution_plan_json: '{"legacy":"plan"}', execution_settlement_json: '{"ok":true}' });

    const repo = new InkRepository(upgraded);
    expect(repo.getOperation('operation-1')).toMatchObject({
      state: 'settled',
      intent: { name: 'read' },
      settlement: { ok: true }
    });
    upgraded.close();
  });
});
