import type { DocumentDelta, DocumentSnapshot, FtsSearchResult, SessionEntry } from '@inkpi/protocol';
import { AppendOnlySessionJournal, FtsSearchEngine, InkDb, InkRepository } from '@inkpi/storage';
import { BackendClosedError } from './errors.js';
import type { ISessionBackend, SessionBackendCapabilities } from './types.js';

export interface SqliteSessionBackendOptions {
  dbPath?: string; // ':memory:' or file path
  journalDir?: string;
  /**
   * 快照自动落位使用的默认工作区/目录 id。
   * 文档必须有 workspace/folder 归属；保存未知文档的快照时按需创建这两个桶。
   * 可注入以避免测试/多租户场景互相污染；默认值仅是约定俗成的桶名，不再是隐藏魔法。
   */
  defaultWorkspaceId?: string;
  defaultFolderId?: string;
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
  private closed = false;

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

  private assertOpen(): void {
    if (this.closed) {
      throw new BackendClosedError(this.name);
    }
  }

  public async initialize(): Promise<void> {
    this.assertOpen();
    // Db initialization occurs in InkDb constructor with DDL
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  /**
   * 为未知文档按需创建归属桶（工作区/目录）再建文档。
   * 这是**显式文档化**的自动落位行为：桶 id 可经 options 注入；
   * `saveOperation` / `saveSessionEntry` 等其他写入路径**不会**触碰这两个桶。
   */
  private ensureDocument(documentId: string, contentSize = 0): void {
    if (this.repo.getDocument(documentId)) return;
    const workspaceId = this.options.defaultWorkspaceId || 'ws_default';
    const folderId = this.options.defaultFolderId || 'folder_default';
    if (!this.repo.getWorkspace(workspaceId)) {
      this.repo.createWorkspace({
        id: workspaceId,
        title: 'Default Workspace',
        owner: 'creator',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
    const folders = this.repo.getFolders(workspaceId);
    if (folders.length === 0) {
      this.repo.createFolder({
        id: folderId,
        workspaceId,
        title: 'Default Folder',
        orderIndex: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
    this.repo.createDocument({
      id: documentId,
      workspaceId,
      folderId,
      title: `Document ${documentId}`,
      orderIndex: 1,
      contentSize,
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  public async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    this.assertOpen();
    this.repo.saveSessionEntry(entry);
  }

  public async getEntries(sessionId: string, fromTimestamp?: number): Promise<SessionEntry[]> {
    this.assertOpen();
    const all = this.repo.getSessionEntries(sessionId);
    if (fromTimestamp === undefined) return all;
    return all.filter((e) => e.timestamp >= fromTimestamp);
  }

  public async saveSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    this.assertOpen();
    this.ensureDocument(snapshot.documentId, snapshot.contentSize);
    this.repo.upsertSnapshot(snapshot);
  }

  public async getSnapshot(documentId: string): Promise<DocumentSnapshot | null> {
    this.assertOpen();
    return this.repo.getSnapshot(documentId) || null;
  }

  public async appendDelta(delta: DocumentDelta): Promise<void> {
    this.assertOpen();
    this.ensureDocument(delta.documentId);
    this.repo.appendDelta(delta);
  }

  public async getDeltas(documentId: string, fromId?: number): Promise<DocumentDelta[]> {
    this.assertOpen();
    return this.repo.getDeltas(documentId, fromId);
  }

  public async search(query: string, limit = 20): Promise<FtsSearchResult[]> {
    this.assertOpen();
    return this.fts.search(query, limit);
  }
}
