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
