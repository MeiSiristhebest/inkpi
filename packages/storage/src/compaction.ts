import type { DocumentSnapshot } from '@inkpi/protocol';
import type { InkDb } from './db.js';
import type { InkRepository } from './repository.js';

export interface CompactionResult {
  documentId: string;
  version: number;
  deletedDeltas: number;
  compactedAt: number;
}

export interface RecoveryResult {
  documentId: string;
  version: number;
  contentMarkdown: string;
  contentJson: string;
  replayedDeltasCount: number;
  contentSize: number;
}

export class CompactionEngine {
  private db: InkDb;
  private repo: InkRepository;

  constructor(db: InkDb, repo: InkRepository) {
    this.db = db;
    this.repo = repo;
  }

  public saveSnapshotAndCompact(
    documentId: string,
    version: number,
    contentJson: string,
    contentMarkdown: string,
    contentSize: number
  ): CompactionResult {
    const now = Date.now();

    const deletedDeltas = this.db.transaction(() => {
      const snapshot: DocumentSnapshot = {
        documentId,
        version,
        contentJson,
        contentMarkdown,
        contentSize,
        updatedAt: now
      };

      this.repo.upsertSnapshot(snapshot);
      const deleted = this.repo.deleteDeltas(documentId, now);

      const updateStmt = this.db.prepare(`
        UPDATE documents SET content_size = ?, updated_at = ? WHERE id = ?
      `);
      updateStmt.run(contentSize, now, documentId);

      return deleted;
    });

    this.db.checkpoint();

    return {
      documentId,
      version,
      deletedDeltas,
      compactedAt: now
    };
  }

  public recoverDocument(documentId: string): RecoveryResult {
    const snapshot = this.repo.getSnapshot(documentId);
    const snapshotTime = snapshot ? snapshot.updatedAt : 0;
    const pendingDeltas = this.repo.getDeltas(documentId, snapshotTime);

    let currentMarkdown = snapshot ? snapshot.contentMarkdown : '';
    let currentJson = snapshot ? snapshot.contentJson : '{"type":"doc","content":[]}';
    let version = snapshot ? snapshot.version : 1;

    // Replay deltas
    for (const delta of pendingDeltas) {
      try {
        const step = JSON.parse(delta.stepJson);
        if (step.type === 'insert' && step.text) {
          const pos = step.from ?? currentMarkdown.length;
          currentMarkdown = currentMarkdown.slice(0, pos) + step.text + currentMarkdown.slice(pos);
        } else if (step.type === 'delete' && step.from !== undefined && step.to !== undefined) {
          currentMarkdown = currentMarkdown.slice(0, step.from) + currentMarkdown.slice(step.to);
        } else if (step.type === 'replace' && step.text) {
          currentMarkdown = step.text;
        }
        version += 1;
      } catch (err) {
        console.error('[CompactionEngine] Failed to replay delta:', err);
      }
    }

    const chineseChars = (currentMarkdown.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (currentMarkdown.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[a-zA-Z0-9_-]+/g) || []).length;
    const contentSize = chineseChars + englishWords;

    return {
      documentId,
      version,
      contentMarkdown: currentMarkdown,
      contentJson: currentJson,
      replayedDeltasCount: pendingDeltas.length,
      contentSize
    };
  }
}
