import type {
  DocumentSnapshot,
  DocumentDelta,
  FtsSearchResult,
  SessionEntry
} from '@inkpi/protocol';

export interface SessionBackendCapabilities {
  readonly fts: boolean;
  readonly snapshots: boolean;
  readonly concurrencyLeases: boolean;
  readonly durableDisk: boolean;
}

/**
 * 统一会话持久化端口契约 (Ports & Adapters Architecture)
 * 会话后端抽象：后端实现负责会话的持久化与装载，领域核心仅依赖本接口。
 */
export interface ISessionBackend {
  readonly name: string;
  readonly capabilities: SessionBackendCapabilities;

  initialize(): Promise<void>;
  close(): Promise<void>;

  // Journal / Events (Event Sourcing)
  appendEntry(sessionId: string, entry: SessionEntry): Promise<void>;
  getEntries(sessionId: string, fromTimestamp?: number): Promise<SessionEntry[]>;

  // Document Snapshots & Deltas
  saveSnapshot(snapshot: DocumentSnapshot): Promise<void>;
  getSnapshot(documentId: string): Promise<DocumentSnapshot | null>;
  appendDelta(delta: DocumentDelta): Promise<void>;
  getDeltas(documentId: string, fromId?: number): Promise<DocumentDelta[]>;

  // Search (Optional depending on capabilities.fts)
  search?(query: string, limit?: number): Promise<FtsSearchResult[]>;
}
