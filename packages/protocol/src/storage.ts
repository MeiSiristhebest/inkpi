export interface Workspace {
  id: string;
  title: string;
  owner: string;
  category?: string;
  targetSize?: number;
  description?: string;
  coverImage?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface Folder {
  id: string;
  workspaceId: string;
  title: string;
  orderIndex: number;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface Document {
  id: string;
  folderId: string;
  workspaceId: string;
  title: string;
  orderIndex: number;
  synopsis?: string;
  contentSize: number;
  status: 'draft' | 'reviewing' | 'completed' | 'published';
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentSnapshot {
  documentId: string;
  version: number;
  contentJson: string; // AST JSON
  contentMarkdown: string;
  contentSize: number;
  updatedAt: number;
}

export interface DocumentDelta {
  id?: number;
  documentId: string;
  stepJson: string; // Step JSON
  clientTimestamp: number;
  createdAt: number;
}

/** FTS5 全文搜索返回项 */
export interface FtsSearchResult {
  documentId: string;
  title: string;
  snippet: string;
  rank: number;
  orderIndex: number;
}

export interface EntityRecord {
  id?: string;
  name: string;
  type?: string;
  status?: string;
  affiliation?: string;
  relationship?: string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AssetRecord {
  id?: string;
  name: string;
  holder?: string;
  owner?: string;
  type?: string;
  state?: string;
  attributes?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TrackRecord {
  id?: string;
  clue?: string;
  summary?: string;
  sourceId?: string;
  status?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LocationRecord {
  id?: string;
  name: string;
  description?: string;
  [key: string]: unknown;
}

/** 结构化通用状态账本 (1:1 移植自 repos/pi FileOperations 思想) */
export interface StateLedger {
  entities: EntityRecord[];
  assets: AssetRecord[];
  tracks: TrackRecord[];
  locations: LocationRecord[];
  /** Optional in practice: all readers fall back to modifiedChapters/modifiedDocuments. */
  modifiedResources?: string[];
  // 兼容别名
  characters?: EntityRecord[];
  items?: AssetRecord[];
  foreshadowings?: TrackRecord[];
  modifiedChapters?: string[];
  modifiedDocuments?: string[];
  [key: string]: unknown;
}

export type NovelStateLedger = StateLedger;
export type CharacterRecord = EntityRecord;
export type ForeshadowingRecord = TrackRecord;

/** 结构化 Compaction 摘要条目 */
export interface CompactionEntry {
  id: string;
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  createdAt: number;
  details?: Record<string, unknown> | { stateLedger?: StateLedger; [key: string]: unknown };
}

/** 多进程排他写锁租约 */
export interface WriterLeaseInfo {
  holderId: string;
  acquiredAt: number;
  expiresAt: number;
  metadata?: string;
}

/** 结构化原子操作状态机契约 */
export type OperationState = 'pending' | 'running' | 'settled' | 'failed' | 'interrupted';

export type OperationType = 'provider_stream' | 'tool_call' | 'workflow_stage' | 'custom';

export interface OperationRecord {
  id: string;
  sessionId: string;
  type: OperationType;
  state: OperationState;
  intent: unknown;
  settlement?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/** 事件溯源日志类型 */
export type SessionEntryType =
  | 'session_start'
  | 'user_message'
  | 'agent_turn'
  | 'draft_revision'
  | 'ledger_mutation'
  | 'compaction'
  | 'tool_execution'
  | 'operation_intent'
  | 'operation_settlement'
  | 'pipeline_stage'
  | 'custom';

export type JournalEntryType = SessionEntryType;

export interface SessionEntry<TPayload = any> {
  id: string;
  sessionId: string;
  /** Session-wide monotonically increasing journal sequence. */
  seq: number;
  /** Immutable tree placement; null means this entry starts a root. */
  parentId: string | null;
  laneId?: string;
  operationId?: string;
  type: SessionEntryType;
  timestamp: number;
  payload: TPayload;
  hash?: string;
  version?: number;
}

export type JournalEntry<TPayload = any> = SessionEntry<TPayload>;

/** JIT 分层记忆检索查询契约 (L1 工作记忆 + L2 摘要 + L3 全局 FTS5 实体) */
export interface JitContextQuery {
  workspaceId?: string;
  currentDocumentId?: string;
  currentText?: string;
  activeReferences?: string[];
  /** @deprecated Use currentText. */
  currentDraftText?: string;
  /** @deprecated Use activeReferences. */
  activeEntities?: string[];
  maxSummaryDocuments?: number;
  maxFtsResults?: number;
}

export interface JitContextResult {
  l1WorkingMemory: {
    activeLedger: StateLedger;
    activeReferences: string[];
    /** @deprecated Use activeReferences. */
    activeEntities: string[];
    /** @deprecated Use activeReferences. */
    activeAssets: string[];
  };
  l2RecentSummaries: Array<{
    documentId: string;
    title: string;
    summary: string;
  }>;
  l3GlobalLore: FtsSearchResult[];
  assembledPromptBlock: string;
}
