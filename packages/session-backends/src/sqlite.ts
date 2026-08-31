import type {
  DocumentSnapshot,
  DocumentDelta,
  FtsSearchResult,
  SessionEntry
} from '@meisiristhebest/protocol';
import {
  InkDb,
  InkRepository,
  AppendOnlySessionJournal,
  FtsSearchEngine
} from '@meisiristhebest/storage';
import type { ISessionBackend, SessionBackendCapabilities } from './types.js';

export interface SqliteSessionBackendOptions {
  dbPath?: string; // ':memory:' or file path
  journalDir?: string;
}

/**
 * 全功能 SQLite + FTS5 + 追加写日志会话持久化适配器 (SqliteSessionBackend)
 * 具备 ACID 事务、FTS5 BM25 全文检索、文档快照与并发写租约。
 */
export class SqliteSessionBackend implements ISessionBackend {
  public readonly name = 'sqlite';
  public readonly capabilities: SessionBackendCapabilities = {
    fts: true,
    snapshots: true,
    concurrencyLeases: true,
    durableDisk: true
  };

  private db: InkDb;
  private repo: InkRepository;
  private fts: FtsSearchEngine;
  private journal?: AppendOnlySessionJournal;
  private options: SqliteSessionBackendOptions;

  constructor(options: SqliteSessionBackendOptions = {}) {
    this.options = options;
    const dbPath = options.dbPath || ':memory:';
    this.db = new InkDb(dbPath);
    this.repo = new InkRepository(this.db);
    this.fts = new FtsSearchEngine(this.db);
    if (options.journalDir) {
      this.journal = new AppendOnlySessionJournal({
        sessionId: 'default',
        filePath: `${options.journalDir}/default.jsonl`
      });
    }
  }

  public async initialize(): Promise<void> {
    // Db initialization occurs in InkDb constructor with DDL
  }

  public async close(): Promise<void> {
    this.db.close();
  }

  private ensureDocument(documentId: string, contentSize = 0): void {
    if (this.repo.getDocument(documentId)) return;
    if (!this.repo.getWorkspace('ws_default')) {
      this.repo.createWorkspace({
        id: 'ws_default',
        title: 'Default Workspace',
        owner: 'creator',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
    const folders = this.repo.getFolders('ws_default');
    if (folders.length === 0) {
      this.repo.createFolder({
        id: 'folder_default',
        workspaceId: 'ws_default',
        title: 'Default Folder',
        orderIndex: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
    this.repo.createDocument({
      id: documentId,
      workspaceId: 'ws_default',
      folderId: 'folder_default',
      title: `Document ${documentId}`,
      orderIndex: 1,
      contentSize,
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  public async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    this.repo.saveSessionEntry(entry);
  }

  public async getEntries(sessionId: string, fromTimestamp?: number): Promise<SessionEntry[]> {
    const all = this.repo.getSessionEntries(sessionId);
    if (fromTimestamp === undefined) return all;
    return all.filter((e) => e.timestamp >= fromTimestamp);
  }

  public async saveSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    this.ensureDocument(snapshot.documentId, snapshot.contentSize);
    this.repo.upsertSnapshot(snapshot);
  }

  public async getSnapshot(documentId: string): Promise<DocumentSnapshot | null> {
    return this.repo.getSnapshot(documentId) || null;
  }

  public async appendDelta(delta: DocumentDelta): Promise<void> {
    this.ensureDocument(delta.documentId);
    this.repo.appendDelta(delta);
  }

  public async getDeltas(documentId: string, fromId?: number): Promise<DocumentDelta[]> {
    return this.repo.getDeltas(documentId, fromId);
  }

  public async search(query: string, limit = 20): Promise<FtsSearchResult[]> {
    return this.fts.search(query, limit);
  }

  public getRepository(): InkRepository {
    return this.repo;
  }

  public getDb(): InkDb {
    return this.db;
  }
}
