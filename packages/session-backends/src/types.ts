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
 * 1:1 对标 Pi SessionBackend 抽象设计
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
