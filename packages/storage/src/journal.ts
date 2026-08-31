import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import type { JournalEntry, JournalEntryType, StateLedger } from '@meisiristhebest/protocol';
import type { InkRepository } from './repository.js';
import type { InkDb } from './db.js';

export interface JournalOptions {
  sessionId: string;
  filePath?: string;
  autoFlush?: boolean;
  idGenerator?: () => string;
  clock?: () => number;
}

export interface JsonlImportOptions {
  /** Strict import is the default so malformed input cannot disappear silently. */
  strict?: boolean;
  onError?: (error: Error, lineNumber: number, line: string) => void;
}

/**
 * 事件溯源不可变日志管理器 (1:1 对标 repos/pi Append-Only JSONL 会话存储架构)
 * 记录每一次交互、章节起草、状态变更与流水线阶段，提供崩溃恢复与 SQLite 状态视图全量投影能力。
 */
export class AppendOnlySessionJournal {
  public readonly sessionId: string;
  private entries: JournalEntry[] = [];
  private entryIndex = new Map<string, JournalEntry>();
  private nextSeq = 1;
  private readonly idGenerator: () => string;
  private readonly clock: () => number;
  private readonly filePath?: string;
  private readonly autoFlush: boolean;

  constructor(options: JournalOptions | string) {
    this.sessionId = typeof options === 'string' ? options : options.sessionId;
    this.idGenerator = typeof options === 'string'
      ? () => `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      : options.idGenerator || (() => `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    this.clock = typeof options === 'string' ? Date.now : options.clock || Date.now;
    this.filePath = typeof options === 'string' ? undefined : options.filePath;
    this.autoFlush = typeof options === 'string' ? true : options.autoFlush ?? true;

    if (this.filePath) {
      if (!this.filePath.trim()) throw new Error('Journal filePath must not be empty.');
      mkdirSync(dirname(this.filePath), { recursive: true });
      if (existsSync(this.filePath)) this.loadFromFile();
    }
  }

  /**
   * 顺序追加一条不可变事件日志
   */
  public append<TPayload = any>(
    type: JournalEntryType,
    payload: TPayload,
    customId?: string,
    parentId: string | null = this.entries[this.entries.length - 1]?.id ?? null
  ): JournalEntry<TPayload> {
    const id = customId || this.idGenerator();
    if (!id.trim()) throw new Error('Journal entry id must not be empty.');
    if (this.entryIndex.has(id)) throw new Error(`Journal entry '${id}' already exists.`);
    const entry: JournalEntry<TPayload> = {
      id,
      sessionId: this.sessionId,
      seq: this.nextSeq,
      parentId,
      type,
      timestamp: this.clock(),
      payload: structuredClone(payload)
    };

    this.storeEntry(entry, true);
    return entry;
  }

  public getEntries(): JournalEntry[] {
    return structuredClone(this.entries);
  }

  public getEntry(id: string): JournalEntry | undefined {
    const entry = this.entryIndex.get(id);
    return entry ? structuredClone(entry) : undefined;
  }

  public getEntriesByType<TPayload = any>(type: JournalEntryType): JournalEntry<TPayload>[] {
    return structuredClone(this.entries.filter((e) => e.type === type)) as JournalEntry<TPayload>[];
  }

  public count(): number {
    return this.entries.length;
  }

  /**
   * 导出为标准 JSONL 字符串 (每行一个完整 JSON 事件)
   */
  public exportToJsonl(): string {
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }

  /**
   * 从 JSONL 字符串全量导入/恢复事件流
   */
  public importFromJsonl(jsonlContent: string, options: JsonlImportOptions = {}): number {
    const lines = jsonlContent.split('\n');
    let imported = 0;
    const strict = options.strict !== false;
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = parseJournalEntry(JSON.parse(trimmed), this.sessionId);
        if (!this.entryIndex.has(entry.id)) {
          this.storeEntry(entry, true);
          imported++;
        }
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        options.onError?.(normalized, index + 1, line);
        if (strict) {
          throw new Error(`Invalid journal JSONL at line ${index + 1}: ${normalized.message}`, { cause: normalized });
        }
      }
    }
    return imported;
  }

  private storeEntry(entry: JournalEntry, persist: boolean): void {
    if (this.entryIndex.has(entry.id)) throw new Error(`Journal entry '${entry.id}' already exists.`);
    validateEntryPlacement(entry, this.entries, this.entryIndex, this.nextSeq);
    if (persist && this.filePath) {
      const fd = openSync(this.filePath, 'a');
      try {
        const line = `${JSON.stringify(entry)}\n`;
        writeFileSync(fd, line, { encoding: 'utf8' });
        if (this.autoFlush) fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    const stored = structuredClone(entry);
    this.entries.push(stored);
    this.entryIndex.set(stored.id, stored);
    this.nextSeq = stored.seq + 1;
  }

  private loadFromFile(): void {
    const content = readFileSync(this.filePath!, 'utf8');
    if (!content) return;

    const hasTrailingNewline = content.endsWith('\n');
    const lines = content.split('\n');
    if (hasTrailingNewline) lines.pop();

    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const entry = parseJournalEntry(JSON.parse(line), this.sessionId);
        this.storeEntry(entry, false);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        const isUnterminatedSyntaxTail =
          index === lines.length - 1 && !hasTrailingNewline && normalized instanceof SyntaxError;
        if (isUnterminatedSyntaxTail) {
          const validPrefix = lines.slice(0, index).filter((item) => item.trim()).join('\n');
          truncateSync(this.filePath!, Buffer.byteLength(validPrefix ? `${validPrefix}\n` : '', 'utf8'));
          return;
        }
        throw new Error(`Invalid journal file at line ${index + 1}: ${normalized.message}`, { cause: normalized });
      }
    }

    if (!hasTrailingNewline) writeFileSync(this.filePath!, `${content}\n`, 'utf8');
  }

  /**
   * 将 JSONL 事件日志全量投影重放到 SQLite 关系型存储 (Event Sourcing -> Materialized View)
   */
  public replayToDb(repo: InkRepository, db: InkDb): {
    replayedCount: number;
    documentsUpdated: number;
    snapshotsCreated: number;
  } {
    let replayedCount = 0;
    let documentsUpdated = 0;
    let snapshotsCreated = 0;

    db.transaction(() => {
      for (const entry of this.entries) {
        let projected = false;
        switch (entry.type) {
          case 'session_start': {
            const ws = entry.payload?.workspace;
            if (ws) {
              const existing = repo.getWorkspace(ws.id);
              if (!existing) {
                repo.createWorkspace(ws);
              }
              projected = true;
            }

            if (entry.payload?.folders && Array.isArray(entry.payload.folders)) {
              for (const v of entry.payload.folders) {
                if (!repo.getFolders(v.workspaceId).some(x => x.id === v.id)) {
                  repo.createFolder(v);
                }
                projected = true;
              }
            }
            if (entry.payload?.documents && Array.isArray(entry.payload.documents)) {
              for (const c of entry.payload.documents) {
                if (!repo.getDocument(c.id)) {
                  repo.createDocument(c);
                }
                projected = true;
              }
            }
            break;
          }

          case 'draft_revision': {
            const p = entry.payload;
            if (!p || typeof p.documentId !== 'string' || typeof p.markdown !== 'string') {
              throw new Error(`draft_revision '${entry.id}' has an invalid payload.`);
            }
            if (!repo.getDocument(p.documentId)) {
              throw new Error(`draft_revision '${entry.id}' references unknown document '${p.documentId}'.`);
            }
            const contentSize = typeof p.contentSize === 'number' && Number.isFinite(p.contentSize)
              ? p.contentSize
              : p.markdown.length;
            repo.upsertSnapshot({
              documentId: p.documentId,
              version: typeof p.version === 'number' ? p.version : entry.timestamp,
              contentJson: typeof p.contentJson === 'string'
                ? p.contentJson
                : JSON.stringify({ type: 'text', content: p.markdown }),
              contentMarkdown: p.markdown,
              contentSize,
              updatedAt: entry.timestamp
            });
            snapshotsCreated++;
            documentsUpdated++;
            projected = true;
            break;
          }

          case 'ledger_mutation': {
            if (!entry.payload?.ledger || typeof entry.payload.ledger !== 'object') {
              throw new Error(`ledger_mutation '${entry.id}' has an invalid payload.`);
            }
            const ledger = entry.payload.ledger as StateLedger;
            const stmt = db.prepare(`
              INSERT OR IGNORE INTO session_compaction_records (id, session_id, summary_text, ledger_json, tokens_before, tokens_after, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
              `ledger_${this.sessionId}_${entry.id}`,
              this.sessionId,
              'State ledger update',
              JSON.stringify(ledger),
              0,
              0,
              entry.timestamp
            );
            projected = true;
            break;
          }

          case 'compaction': {
            if (!entry.payload || typeof entry.payload !== 'object' || typeof entry.payload.summary !== 'string') {
              throw new Error(`compaction '${entry.id}' has an invalid payload.`);
            }
            const comp = entry.payload;
            const stmt = db.prepare(`
              INSERT OR IGNORE INTO session_compaction_records (id, session_id, summary_text, ledger_json, tokens_before, tokens_after, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
              `comp_${this.sessionId}_${entry.id}`,
              this.sessionId,
              comp.summary,
              JSON.stringify(comp.details?.stateLedger || {}),
              comp.tokensBefore || 0,
              comp.estimatedTokensAfter || 0,
              entry.timestamp
            );
            projected = true;
            break;
          }

          case 'operation_intent': {
            const op = entry.payload;
            if (op && typeof op.id === 'string') {
              repo.saveOperation({
                id: op.id,
                sessionId: this.sessionId,
                type: op.type || 'custom',
                state: 'running',
                intent: op.intent,
                createdAt: entry.timestamp,
                updatedAt: entry.timestamp
              });
              projected = true;
            }
            break;
          }

          case 'operation_settlement': {
            const op = entry.payload;
            if (op && typeof op.id === 'string') {
              repo.saveOperation({
                id: op.id,
                sessionId: this.sessionId,
                type: op.type || 'custom',
                state: op.error ? 'failed' : 'settled',
                intent: op.intent,
                settlement: op.settlement,
                error: op.error,
                createdAt: op.createdAt || entry.timestamp,
                updatedAt: entry.timestamp
              });
              projected = true;
            }
            break;
          }

          default:
            break;
        }

        // Always save every session entry to relational session_entries projection
        repo.saveSessionEntry(entry);
        if (projected) replayedCount++;
      }
    });

    return {
      replayedCount,
      documentsUpdated,
      snapshotsCreated
    };
  }
}

const JOURNAL_ENTRY_TYPES = new Set<JournalEntryType>([
  'session_start',
  'user_message',
  'agent_turn',
  'draft_revision',
  'ledger_mutation',
  'compaction',
  'tool_execution',
  'operation_intent',
  'operation_settlement',
  'pipeline_stage',
  'custom'
]);

function parseJournalEntry(value: unknown, sessionId: string): JournalEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('entry must be an object.');
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !entry.id.trim()) throw new Error('entry.id must be a non-empty string.');
  if (entry.sessionId !== sessionId) throw new Error(`entry.sessionId must equal '${sessionId}'.`);
  if (
    typeof entry.seq !== 'number' ||
    !Number.isSafeInteger(entry.seq) ||
    entry.seq < 1
  ) {
    throw new Error('entry.seq must be a positive safe integer.');
  }
  if (entry.parentId !== null && (typeof entry.parentId !== 'string' || !entry.parentId.trim())) {
    throw new Error('entry.parentId must be null or a non-empty string.');
  }
  if (typeof entry.type !== 'string' || !JOURNAL_ENTRY_TYPES.has(entry.type as JournalEntryType)) {
    throw new Error(`entry.type '${String(entry.type)}' is not supported.`);
  }
  if (typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp) || entry.timestamp < 0) {
    throw new Error('entry.timestamp must be a non-negative finite number.');
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'payload')) {
    throw new Error('entry.payload is required.');
  }
  return entry as unknown as JournalEntry;
}

function validateEntryPlacement(
  entry: JournalEntry,
  entries: JournalEntry[],
  entryIndex: Map<string, JournalEntry>,
  nextSeq: number
): void {
  const previous = entries[entries.length - 1];
  if (previous && entry.seq <= previous.seq) {
    throw new Error(`Journal entry '${entry.id}' has non-increasing seq ${entry.seq}.`);
  }
  if (!previous && entry.seq < 1) {
    throw new Error(`Journal entry '${entry.id}' has invalid seq ${entry.seq}.`);
  }
  if (entry.seq !== nextSeq) {
    throw new Error(`Journal entry '${entry.id}' expected seq ${nextSeq}, received ${entry.seq}.`);
  }
  if (entry.parentId !== null) {
    const parent = entryIndex.get(entry.parentId);
    if (!parent) {
      throw new Error(`Journal entry '${entry.id}' references unknown parent '${entry.parentId}'.`);
    }
    if (parent.seq >= entry.seq) {
      throw new Error(`Journal entry '${entry.id}' parent '${entry.parentId}' must precede it.`);
    }
  }
}
