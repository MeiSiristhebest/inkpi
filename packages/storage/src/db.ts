import { type DomainChangeSet, calculateDomainChangeSetChecksum } from '@inkpi/protocol';
import { SESSION_ENTRIES_DDL, STORAGE_SCHEMA_DDL } from './ddl.js';
import { deserializeDomainChanges } from './domain-change-codec.js';
import type { IDb, PreparedStatement } from './ports.js';

/** Increment when the Runtime's persisted SQLite shape changes. */
export const STORAGE_SCHEMA_VERSION = 2;

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  close(): void;
}

interface SqliteModule {
  Database?: new (path: string) => SqliteDatabase;
  DatabaseSync?: new (path: string) => SqliteDatabase;
}

// Node 22+ exposes the synchronous driver as `node:sqlite`; Bun exposes the
// compatible synchronous API as `bun:sqlite`. Keep the specifier dynamic so a
// Bun-compiled standalone daemon never tries to load Node's unsupported module.
const sqliteModuleName = process.versions.bun ? 'bun:sqlite' : 'node:sqlite';
// SAFETY: both supported SQLite modules expose the synchronous methods modeled by SqliteModule.
const sqliteModule = (await import(sqliteModuleName)) as unknown as SqliteModule;
const SqliteDatabase = (() => {
  const database = process.versions.bun ? sqliteModule.Database : sqliteModule.DatabaseSync;
  if (!database) {
    throw new Error(`SQLite driver is unavailable for runtime '${process.release.name}'.`);
  }
  return database;
})();

export class InkDb implements IDb {
  private db: SqliteDatabase;
  private dbPath: string;

  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    this.db = new SqliteDatabase(dbPath);
    try {
      this.initSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  public initSchema(): void {
    const storedVersion = Number(
      (this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0
    );
    if (storedVersion > STORAGE_SCHEMA_VERSION) {
      throw new Error(
        `Runtime storage schema ${storedVersion} is newer than supported schema ${STORAGE_SCHEMA_VERSION}.`
      );
    }

    // `CREATE TABLE IF NOT EXISTS` cannot add a column to a table an earlier
    // build already created, but the index that references it still runs inside
    // the same exec — so columns that appear in an index must be migrated first
    // or upgrading an existing database throws `no such column` and aborts.
    this.transaction(() => {
      this.migrateSessionEntries();
      this.ensureColumn('artifacts', 'workspace_id', 'TEXT');
      this.db.exec(STORAGE_SCHEMA_DDL);
      // Keep databases created by older versions readable while adding the
      // metadata required for guarded lane fast-forward merges.
      this.ensureColumn('lanes', 'parent_lane_id', 'TEXT');
      this.ensureColumn('domain_change_sets', 'checksum', "TEXT NOT NULL DEFAULT ''");
      this.ensureColumn('task_executions', 'run_json', 'TEXT');
      this.ensureColumn('task_executions', 'steps_json', 'TEXT');
      this.ensureColumn('task_executions', 'execution_attempts_json', 'TEXT');
      this.ensureColumn('task_executions', 'resume_token_json', 'TEXT');
      this.ensureColumn('task_executions', 'execution_snapshot_json', 'TEXT');
      this.ensureColumn('task_executions', 'steering_json', 'TEXT');
      this.ensureColumn('writer_leases', 'fencing_token', 'INTEGER NOT NULL DEFAULT 0');
      const addedBaseSnapshot = this.ensureColumn('branch_tips', 'base_snapshot_version', 'INTEGER NOT NULL DEFAULT 0');
      const addedBaseDelta = this.ensureColumn('branch_tips', 'base_delta_id', 'INTEGER NOT NULL DEFAULT 0');
      if (addedBaseSnapshot || addedBaseDelta) {
        // Older databases had no fork baseline. Treat their current tips as the
        // only recoverable baseline instead of inventing a zero-valued one.
        this.db.exec(`
        UPDATE branch_tips
        SET base_snapshot_version = head_snapshot_version,
            base_delta_id = last_delta_id
      `);
      }
      this.backfillDomainChangeSetChecksums();
      this.db.exec(`PRAGMA user_version = ${STORAGE_SCHEMA_VERSION}`);
    });
  }

  private migrateSessionEntries(): void {
    const columns = this.db.prepare('PRAGMA table_info(session_entries)').all() as Array<{ name: string; pk: number }>;
    if (!columns.length) return;
    if (columns.some((column) => column.name === 'session_id' && column.pk > 0)) return;
    const knownColumns = new Set([
      'id',
      'session_id',
      'seq',
      'parent_id',
      'lane_id',
      'operation_id',
      'type',
      'payload_json',
      'timestamp',
      'version',
      'hash'
    ]);
    if (columns.some((column) => !knownColumns.has(column.name))) {
      throw new Error('Cannot migrate session entries with unknown columns without discarding data.');
    }
    const schemaObjects = this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE tbl_name = 'session_entries' AND type IN ('index', 'trigger') AND sql IS NOT NULL"
      )
      .all() as Array<{ sql: string }>;
    // Entries retain their IDs when copied into another session. The old global
    // ID key would overwrite the source instead of preserving the fork.
    this.db.exec('ALTER TABLE session_entries RENAME TO session_entries_v1');
    this.db.exec(SESSION_ENTRIES_DDL);
    this.db.exec(`INSERT INTO session_entries (id, session_id, seq, parent_id, lane_id, operation_id, type, payload_json, timestamp, version, hash)
      SELECT id, session_id, seq, parent_id, lane_id, operation_id, type, payload_json, timestamp, version, ${columns.some((column) => column.name === 'hash') ? 'hash' : 'NULL'} FROM session_entries_v1`);
    this.db.exec('DROP TABLE session_entries_v1');
    for (const object of schemaObjects) this.db.exec(object.sql);
  }

  private ensureColumn(
    table: 'artifacts' | 'lanes' | 'branch_tips' | 'domain_change_sets' | 'task_executions' | 'writer_leases',
    column: string,
    definition: string
  ): boolean {
    if (!this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
      // Fresh database: the table is about to be created from the full DDL.
      return false;
    }
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  }

  private backfillDomainChangeSetChecksums(): void {
    const rows = this.db
      .prepare(
        'SELECT id, workspace_id, source_device_id, base_revision, revision, changes_json, created_at, checksum FROM domain_change_sets'
      )
      .all() as Array<Record<string, unknown>>;
    const update = this.db.prepare('UPDATE domain_change_sets SET checksum = ? WHERE id = ?');
    for (const row of rows) {
      const existing = String(row.checksum ?? '');
      if (existing) continue;
      let changes: unknown;
      try {
        changes = deserializeDomainChanges(String(row.changes_json));
      } catch (error) {
        throw new Error(`Invalid domain change set JSON for ${String(row.id)}`, { cause: error });
      }
      const changeSet = {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        sourceDeviceId: String(row.source_device_id),
        baseRevision: Number(row.base_revision),
        revision: Number(row.revision),
        changes,
        createdAt: Number(row.created_at)
      } as Omit<DomainChangeSet, 'checksum'>;
      update.run(calculateDomainChangeSetChecksum(changeSet), changeSet.id);
    }
  }

  public exec(sql: string): void {
    this.db.exec(sql);
  }

  public prepare(sql: string) {
    return this.db.prepare(sql);
  }

  private inTransaction = false;

  public transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      return fn();
    }
    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      this.inTransaction = false;
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch (rollbackError) {
        this.inTransaction = false;
        throw new AggregateError([err, rollbackError], 'SQLite transaction failed and rollback also failed');
      }
      this.inTransaction = false;
      throw err;
    }
  }

  public checkpoint(): void {
    // Best-effort WAL truncation. In-memory databases accept the pragma as a
    // no-op, so there is no need to swallow errors here; a genuine failure
    // (corrupt WAL, I/O error) must surface rather than be silently ignored.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  public close(): void {
    this.db.close();
  }

  public getPath(): string {
    return this.dbPath;
  }
}
