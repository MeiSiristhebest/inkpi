/**
 * Storage ports (inner abstraction).
 *
 * Per the hexagonal / ports-and-adapters discipline, the *abstraction* lives in
 * the storage package but is declared independently of any concrete driver.
 * `InkDb` is one adapter over `node:sqlite`; `InkRepository` is one adapter over
 * `IDb`. Domain code should depend on `IRepository` / `IDb`, never on `InkDb`, so
 * that swapping the storage engine does not touch business logic.
 */

import type {
  Document,
  DocumentDelta,
  DocumentSnapshot,
  Folder,
  OperationRecord,
  SessionEntry,
  Workspace
} from '@inkpi/protocol';

/**
 * A prepared statement returned by {@link IDb.prepare}. Mirrors the structural
 * subset of `node:sqlite`'s `Statement` that the repository actually uses, so
 * the repository depends on the port rather than the concrete driver.
 */
export interface PreparedStatement {
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * Low-level database handle port. `InkDb` (over `node:sqlite`) is one
 * implementation. An alternative engine (e.g. a remote or in-memory mock for
 * tests) only needs to satisfy this contract.
 */
export interface IDb {
  /** Create schema and migrate older databases forward. Idempotent. */
  initSchema(): void;
  /** Execute raw SQL with no parameters. */
  exec(sql: string): void;
  /** Prepare a parameterized statement. */
  prepare(sql: string): PreparedStatement;
  /** Run `fn` inside a transaction (nested calls reuse the outer transaction). */
  transaction<T>(fn: () => T): T;
  /** Truncate the WAL and flush to the main database file. */
  checkpoint(): void;
  /** Close the underlying connection. */
  close(): void;
  /** Absolute path of the database file (`:memory:` for in-memory). */
  getPath(): string;
}

/**
 * High-level persistence port for the session/document domain. `InkRepository`
 * (over `IDb`) is one implementation. Domain consumers depend on this port.
 */
export interface IRepository {
  createWorkspace(ws: Workspace): void;
  getWorkspace(id: string): Workspace | undefined;
  createFolder(volume: Folder): void;
  getFolders(workspaceId: string): Folder[];
  createDocument(chapter: Document): void;
  getDocument(id: string): Document | undefined;
  getDocuments(folderId: string): Document[];
  appendDelta(delta: DocumentDelta): number;
  /**
   * Closed-interval filter by auto-increment id. Returns deltas with `id >= afterId`;
   * `afterId` defaults to 0 (all deltas for the document).
   */
  getDeltas(documentId: string, afterId?: number): DocumentDelta[];
  /** Filter deltas by creation timestamp. Used by snapshot compaction replay only. */
  getDeltasSince(documentId: string, sinceTimestamp: number): DocumentDelta[];
  /** Delete deltas with `id <= upToId`. Returns the number of rows removed. */
  deleteDeltas(documentId: string, upToId: number): number;
  /** Delete deltas created at or before `beforeTimestamp`. Returns rows removed. */
  deleteDeltasBefore(documentId: string, beforeTimestamp: number): number;
  upsertSnapshot(snapshot: DocumentSnapshot): void;
  getSnapshot(documentId: string): DocumentSnapshot | undefined;
  saveOperation(record: OperationRecord): void;
  getOperation(id: string): OperationRecord | undefined;
  getOperations(sessionId: string): OperationRecord[];
  saveSessionEntry(entry: SessionEntry): void;
  getSessionEntries(sessionId: string): SessionEntry[];
}
