import type { JournalEntry, JournalEntryType, StateLedger } from '@inkpi/protocol';
import type { InkRepository } from './repository.js';
import type { InkDb } from './db.js';

export interface JournalOptions {
  sessionId: string;
  filePath?: string;
  autoFlush?: boolean;
}

/**
 * 事件溯源不可变日志管理器 (1:1 对标 repos/pi Append-Only JSONL 会话存储架构)
 * 记录每一次交互、章节起草、状态变更与流水线阶段，提供崩溃恢复与 SQLite 状态视图全量投影能力。
 */
export class AppendOnlySessionJournal {
  public readonly sessionId: string;
  private entries: JournalEntry[] = [];
  private entryIndex = new Map<string, JournalEntry>();

  constructor(options: JournalOptions | string) {
    this.sessionId = typeof options === 'string' ? options : options.sessionId;
  }

  /**
   * 顺序追加一条不可变事件日志
   */
  public append<TPayload = any>(type: JournalEntryType, payload: TPayload, customId?: string): JournalEntry<TPayload> {
    const entry: JournalEntry<TPayload> = {
      id: customId || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: this.sessionId,
      type,
      timestamp: Date.now(),
      payload
    };

    this.entries.push(entry);
    this.entryIndex.set(entry.id, entry);
    return entry;
  }

  public getEntries(): JournalEntry[] {
    return [...this.entries];
  }

  public getEntry(id: string): JournalEntry | undefined {
    return this.entryIndex.get(id);
  }

  public getEntriesByType<TPayload = any>(type: JournalEntryType): JournalEntry<TPayload>[] {
    return this.entries.filter((e) => e.type === type) as JournalEntry<TPayload>[];
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
  public importFromJsonl(jsonlContent: string): number {
    const lines = jsonlContent.split('\n');
    let imported = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as JournalEntry;
        if (entry.id && entry.type) {
          if (!this.entryIndex.has(entry.id)) {
            this.entries.push(entry);
            this.entryIndex.set(entry.id, entry);
            imported++;
          }
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
    return imported;
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
        replayedCount++;
        switch (entry.type) {
          case 'session_start': {
            if (entry.payload?.book) {
              const b = entry.payload.book;
              const existing = repo.getWorkspace(b.id);
              if (!existing) {
                repo.createWorkspace(b);
              }
            }
            if (entry.payload?.folders && Array.isArray(entry.payload.folders)) {
              for (const v of entry.payload.folders) {
                if (!repo.getFolders(v.workspaceId).some(x => x.id === v.id)) {
                  repo.createFolder(v);
                }
              }
            }
            if (entry.payload?.documents && Array.isArray(entry.payload.documents)) {
              for (const c of entry.payload.documents) {
                if (!repo.getDocument(c.id)) {
                  repo.createDocument(c);
                }
              }
            }
            break;
          }

          case 'draft_revision': {
            if (entry.payload?.documentId && entry.payload?.markdown !== undefined) {
              const p = entry.payload;
              const currentDocument = repo.getDocument(p.documentId);
              if (currentDocument) {
                const words = (p.markdown.match(/[\u4e00-\u9fa5a-zA-Z0-9]/g) || []).length;
                repo.upsertSnapshot({
                  documentId: p.documentId,
                  version: p.version || Date.now(),
                  contentJson: JSON.stringify({ type: 'doc', content: p.markdown }),
                  contentMarkdown: p.markdown,
                  contentSize: words,
                  updatedAt: entry.timestamp
                });
                snapshotsCreated++;
                documentsUpdated++;
              }
            }
            break;
          }

          case 'ledger_mutation': {
            if (entry.payload?.ledger) {
              const ledger = entry.payload.ledger as StateLedger;
              const stmt = db.prepare(`
                INSERT INTO session_compaction_records (id, session_id, summary_text, ledger_json, tokens_before, tokens_after, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `);
              stmt.run(
                `ledger_${entry.id}`,
                this.sessionId,
                'State ledger auto-sync',
                JSON.stringify(ledger),
                0,
                0,
                entry.timestamp
              );
            }
            break;
          }

          case 'compaction': {
            if (entry.payload) {
              const comp = entry.payload;
              const stmt = db.prepare(`
                INSERT INTO session_compaction_records (id, session_id, summary_text, ledger_json, tokens_before, tokens_after, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `);
              stmt.run(
                comp.id || `comp_${entry.id}`,
                this.sessionId,
                comp.summary || 'Phase compaction',
                JSON.stringify(comp.details?.stateLedger || {}),
                comp.tokensBefore || 0,
                comp.estimatedTokensAfter || 0,
                entry.timestamp
              );
            }
            break;
          }

          default:
            break;
        }
      }
    });

    return {
      replayedCount,
      documentsUpdated,
      snapshotsCreated
    };
  }
}
