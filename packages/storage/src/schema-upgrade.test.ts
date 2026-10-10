import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InkDb, STORAGE_SCHEMA_VERSION } from './db.js';
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
  function restoreVersionOneEntries(db: InkDb): void {
    db.exec(`
      ALTER TABLE session_entries RENAME TO session_entries_new;
      CREATE TABLE session_entries (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        parent_id TEXT, lane_id TEXT, operation_id TEXT, type TEXT NOT NULL,
        payload_json TEXT NOT NULL, timestamp INTEGER NOT NULL, version INTEGER DEFAULT 1
      );
      INSERT INTO session_entries SELECT id, session_id, seq, parent_id, lane_id, operation_id, type, payload_json, timestamp, version FROM session_entries_new;
      DROP TABLE session_entries_new;
      PRAGMA user_version = 1;
    `);
  }

  it('migrates version one entries losslessly to session-scoped IDs', () => {
    const path = tempDbPath();
    const created = new InkDb(path);
    const entry = {
      id: 'original',
      sessionId: 'source',
      seq: 7,
      parentId: null,
      type: 'compaction' as const,
      payload: { firstKeptEntryId: 'external', details: { keep: [1, 2] } },
      timestamp: 10,
      version: 1
    };
    new InkRepository(created).saveSessionEntry(entry);
    restoreVersionOneEntries(created);
    created.exec('CREATE INDEX custom_entry_operation ON session_entries(operation_id)');
    created.exec(
      "CREATE TRIGGER custom_entry_guard BEFORE INSERT ON session_entries WHEN NEW.id = 'blocked' BEGIN SELECT RAISE(ABORT, 'custom guard'); END"
    );
    created.close();
    const migrated = new InkDb(path);
    const repo = new InkRepository(migrated);
    expect(repo.getSessionEntries('source')).toStrictEqual([entry]);
    repo.saveSessionEntry({ ...entry, sessionId: 'fork' });
    expect(repo.getSessionEntries('source')).toStrictEqual([entry]);
    expect(repo.getSessionEntries('fork')).toStrictEqual([{ ...entry, sessionId: 'fork' }]);
    expect(indexOf(migrated, 'custom_entry_operation')).toEqual(['custom_entry_operation']);
    expect(() => repo.saveSessionEntry({ ...entry, id: 'blocked', sessionId: 'fork' })).toThrow(/custom guard/);
    expect(migrated.prepare('PRAGMA user_version').get()).toEqual({ user_version: STORAGE_SCHEMA_VERSION });
    migrated.close();
  });

  it('rolls back schema and data migration when a later migration stage fails', () => {
    const path = tempDbPath();
    const db = new InkDb(path);
    new InkRepository(db).saveSessionEntry({
      id: 'retained',
      sessionId: 'source',
      seq: 1,
      parentId: null,
      type: 'user_message',
      payload: {},
      timestamp: 1
    });
    restoreVersionOneEntries(db);
    db.exec(
      "INSERT INTO domain_change_sets (id, workspace_id, source_device_id, base_revision, revision, changes_json, checksum, created_at) VALUES ('bad', 'ws', 'dev', 0, 1, 'invalid JSON', '', 1)"
    );
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'session_entries'").get();
    const row = db.prepare('SELECT * FROM session_entries').get();
    expect(() => db.initSchema()).toThrow(/Invalid domain change set JSON/);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'session_entries'").get()).toEqual(schema);
    expect(db.prepare('SELECT * FROM session_entries').get()).toEqual(row);
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_entries_v1'").get()).toBeUndefined();
    db.exec("UPDATE domain_change_sets SET changes_json = '[]' WHERE id = 'bad'");
    db.initSchema();
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: STORAGE_SCHEMA_VERSION });
    db.close();
  });

  it('refuses to remove unknown legacy columns and their data', () => {
    const db = new InkDb();
    restoreVersionOneEntries(db);
    db.exec(
      "ALTER TABLE session_entries ADD COLUMN custom_data TEXT; INSERT INTO session_entries (id, session_id, seq, type, payload_json, timestamp, custom_data) VALUES ('kept', 'source', 1, 'custom', '{}', 1, 'preserve me')"
    );
    expect(() => db.initSchema()).toThrow(/unknown columns/);
    expect(db.prepare('SELECT custom_data FROM session_entries').get()).toEqual({ custom_data: 'preserve me' });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    db.close();
  });

  it('rejects a database created by a newer Runtime storage schema', () => {
    const path = tempDbPath();
    const created = new InkDb(path);
    created.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION + 1}`);
    created.close();

    expect(() => new InkDb(path)).toThrow(
      `Runtime storage schema ${STORAGE_SCHEMA_VERSION + 1} is newer than supported schema ${STORAGE_SCHEMA_VERSION}.`
    );
  });

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
        .prepare(
          'SELECT task_json, snapshot_json, attempts, execution_plan_json, execution_settlement_json FROM task_executions WHERE task_id = ?'
        )
        .get('task-1')
    ).toEqual({
      task_json: '{"id":"task-1"}',
      snapshot_json: '{"status":"interrupted"}',
      attempts: 1,
      execution_plan_json: '{"legacy":"plan"}',
      execution_settlement_json: '{"ok":true}'
    });

    const repo = new InkRepository(upgraded);
    expect(repo.getOperation('operation-1')).toMatchObject({
      state: 'settled',
      intent: { name: 'read' },
      settlement: { ok: true }
    });
    upgraded.close();
  });
});
