import { DatabaseSync } from 'node:sqlite';
import { STORAGE_SCHEMA_DDL } from './ddl.js';

export class InkDb {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(dbPath = ':memory:') {
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  public initSchema(): void {
    this.db.exec(STORAGE_SCHEMA_DDL);
    // Keep databases created by older versions readable while adding the
    // metadata required for guarded lane fast-forward merges.
    this.ensureColumn('lanes', 'parent_lane_id', 'TEXT');
    const addedBaseSnapshot = this.ensureColumn(
      'branch_tips',
      'base_snapshot_version',
      'INTEGER NOT NULL DEFAULT 0'
    );
    const addedBaseDelta = this.ensureColumn(
      'branch_tips',
      'base_delta_id',
      'INTEGER NOT NULL DEFAULT 0'
    );
    if (addedBaseSnapshot || addedBaseDelta) {
      // Older databases had no fork baseline. Treat their current tips as the
      // only recoverable baseline instead of inventing a zero-valued one.
      this.db.exec(`
        UPDATE branch_tips
        SET base_snapshot_version = head_snapshot_version,
            base_delta_id = last_delta_id
      `);
    }
  }

  private ensureColumn(table: 'lanes' | 'branch_tips', column: string, definition: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((entry) => entry.name === column)) return false;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
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
      } catch {}
      this.inTransaction = false;
      throw err;
    }
  }


  public checkpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // Memory db may ignore wal checkpoint
    }
  }

  public close(): void {
    this.db.close();
  }

  public getPath(): string {
    return this.dbPath;
  }
}
