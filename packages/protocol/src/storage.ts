import type { RuntimeState } from './pipeline.js';

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
  /** FTS5 的 bm25 相关性分数。朴素（非 FTS）后端不做相关性计算，诚实省略本字段——不返回伪造值。 */
  rank?: number;
  orderIndex: number;
}

/**
 * Legacy compatibility records.
 *
 * These shapes are retained for storage and older integrations only. Generic
 * Runtime code must use `RuntimeState` and an injected domain adapter instead
 * of depending on any of these named collections.
 */
export interface LegacyEntityRecord {
  [key: string]: unknown;
  id?: string;
  name: string;
  type?: string;
  status?: string;
  affiliation?: string;
  relationship?: string;
  attributes?: Record<string, unknown>;
}

export interface LegacyAssetRecord {
  [key: string]: unknown;
  id?: string;
  name: string;
  holder?: string;
  owner?: string;
  type?: string;
  state?: string;
  attributes?: Record<string, unknown>;
}

export interface LegacyTrackRecord {
  [key: string]: unknown;
  id?: string;
  clue?: string;
  summary?: string;
  sourceId?: string;
  status?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
}

export interface LegacyLocationRecord {
  [key: string]: unknown;
  id?: string;
  name: string;
  description?: string;
}

/**
 * Legacy structured state snapshot.
 *
 * This is an adapter contract, not the Runtime state model. It exists so
 * storage, exports, and older clients can continue to exchange the historical
 * shape while generic Runtime workflows carry opaque `RuntimeState` values.
 */
export interface LegacyStateLedger extends RuntimeState {
  entities: LegacyEntityRecord[];
  assets: LegacyAssetRecord[];
  tracks: LegacyTrackRecord[];
  locations: LegacyLocationRecord[];
  /** Optional in practice: all readers fall back to modifiedChapters/modifiedDocuments. */
  modifiedResources?: string[];
  /** Free-form domain extension bag (e.g. workflow-injected state). Typed explicitly; do not use an index signature. */
  customExtension?: unknown;
  // 兼容别名
  characters?: EntityRecord[];
  items?: AssetRecord[];
  foreshadowings?: TrackRecord[];
  modifiedChapters?: string[];
  modifiedDocuments?: string[];
}

/** @deprecated Use `RuntimeState` with an explicit domain adapter. */
export type StateLedger = LegacyStateLedger;
/** @deprecated Use `RuntimeState` with an explicit domain adapter. */
export type NovelStateLedger = LegacyStateLedger;
/** @deprecated Use an adapter-owned record shape. */
export type EntityRecord = LegacyEntityRecord;
/** @deprecated Use an adapter-owned record shape. */
export type AssetRecord = LegacyAssetRecord;
/** @deprecated Use an adapter-owned record shape. */
export type TrackRecord = LegacyTrackRecord;
/** @deprecated Use an adapter-owned record shape. */
export type LocationRecord = LegacyLocationRecord;
/** @deprecated Use an adapter-owned record shape. */
export type CharacterRecord = LegacyEntityRecord;
/** @deprecated Use an adapter-owned record shape. */
export type ForeshadowingRecord = LegacyTrackRecord;

/**
 * Opaque compaction metadata. The optional `stateLedger` member is retained
 * only as an un-interpreted compatibility payload; Runtime does not read or
 * construct its legacy shape.
 */
export interface OpaqueCompactionDetails {
  [key: string]: unknown;
  /** @deprecated Legacy persistence member; use `runtimeState`. */
  stateLedger?: RuntimeState;
}

/** 结构化 Compaction 摘要条目 */
export interface CompactionEntry {
  id: string;
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  estimatedTokensAfter?: number;
  createdAt: number;
  details?: OpaqueCompactionDetails;
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
  /**
   * 助手流式紧凑帧（对齐上游 pi assistant-durability）。
   * 辅助观察数据：缺失合法、不证明成败、不选重启点；`agent_turn` 结算落地后即被归约丢弃。
   */
  | 'assistant_frame'
  /**
   * 工具进度持久化检查点（对齐上游 pi tool-durability "checkpoint"）。
   * 仅承载"完整有界"快照，绝不作为工具完成证明；基础恢复不读取它。
   */
  | 'tool_progress'
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

/**
 * JIT retrieval result with caller-owned working state. The generic parameter
 * lets Runtime callers carry an opaque state; the historical default remains
 * `LegacyStateLedger` so existing storage integrations keep their inferred
 * record fields without a migration flag.
 */
export interface JitContextResult<TState extends RuntimeState = LegacyStateLedger> {
  l1WorkingMemory: {
    activeLedger: TState;
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

/** @deprecated Use `JitContextResult<RuntimeState>` in new integrations. */
export type LegacyJitContextResult = JitContextResult<LegacyStateLedger>;
