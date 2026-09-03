import type { DocumentDelta, DocumentSnapshot, FtsSearchResult, SessionEntry } from '@inkpi/protocol';

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

  /**
   * 释放后端持有的全部资源（连接、文件句柄、内存映射等）。
   *
   * **后置条件（契约，实现必须遵守）：**
   * 1. 幂等：重复调用 `close()` 不得抛错，也不得产生副作用。
   * 2. 终止态：一旦 `close()` 成功返回，后端进入终止态，此后调用本接口的**任意其他方法**
   *    （含 `initialize`）都必须以 `BackendClosedError` 拒绝，而不是静默写穿或返回陈旧数据。
   * 3. 不同后端的"破坏性"语义可以不同（Memory 的 `close` 丢弃数据；Jsonl/Sqlite 的 `close`
   *    仅释放连接，数据仍可从磁盘重新装载），但"终止态拒绝后续调用"这一条对所有后端一致。
   */
  close(): Promise<void>;

  // Journal / Events (Event Sourcing)
  appendEntry(sessionId: string, entry: SessionEntry): Promise<void>;
  getEntries(sessionId: string, fromTimestamp?: number): Promise<SessionEntry[]>;

  // Document Snapshots & Deltas
  saveSnapshot(snapshot: DocumentSnapshot): Promise<void>;
  getSnapshot(documentId: string): Promise<DocumentSnapshot | null>;
  appendDelta(delta: DocumentDelta): Promise<void>;
  getDeltas(documentId: string, fromId?: number): Promise<DocumentDelta[]>;

  /**
   * 全文检索：所有后端都必须实现（必需的端口成员，不是可选能力）。
   *
   * 历史遗留：`search` 曾被声明为可选（`search?`），理由是"依赖 capabilities.fts"。
   * 但仓库内三个后端（Sqlite / Jsonl / Memory）全部实现了它，可选声明属于伪接口隔离
   * （fake ISP）——它并未描述真实约束，只是让调用方每次都得写 `backend.search?.()`，
   * 而"不实现"的情况从未发生，反而退化成静默跳过搜索的隐患。
   *
   * 能力差异通过**返回值**表达，而非通过"方法是否存在"表达：
   * - FTS 后端（`capabilities.fts === true`）返回带 `rank` 的结果；
   * - 朴素后端做关键词匹配，诚实省略 `rank` 字段（不伪造 -1 或 0）。
   */
  search(query: string, limit?: number): Promise<FtsSearchResult[]>;
}
