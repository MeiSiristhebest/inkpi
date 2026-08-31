import type { DocumentSnapshot } from '@meisiristhebest/protocol';
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
  recoveryErrors: RecoveryError[];
}

export interface RecoveryError {
  deltaId?: number;
  message: string;
}

export interface RecoveryOptions {
  /** Strict recovery is the default so incomplete content cannot look valid. */
  strict?: boolean;
  onError?: (error: RecoveryError) => void;
  measureContent?: (contentMarkdown: string) => number;
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

  public recoverDocument(documentId: string, options: RecoveryOptions = {}): RecoveryResult {
    const snapshot = this.repo.getSnapshot(documentId);
    const snapshotTime = snapshot ? snapshot.updatedAt : 0;
    const pendingDeltas = this.repo.getDeltas(documentId, snapshotTime);

    let currentMarkdown = snapshot ? snapshot.contentMarkdown : '';
    let currentJson = snapshot ? snapshot.contentJson : '{"type":"doc","content":[]}';
    let version = snapshot ? snapshot.version : 1;
    let replayedDeltasCount = 0;
    const recoveryErrors: RecoveryError[] = [];

    // Replay deltas
    for (const delta of pendingDeltas) {
      try {
        const step = JSON.parse(delta.stepJson);
        let applied = false;
        if (step?.type === 'insert' && typeof step.text === 'string') {
          const pos = step.from ?? currentMarkdown.length;
          if (!isValidPosition(pos, currentMarkdown.length)) throw new Error('insert.from is out of bounds.');
          currentMarkdown = currentMarkdown.slice(0, pos) + step.text + currentMarkdown.slice(pos);
          applied = true;
        } else if (
          step?.type === 'delete' &&
          Number.isInteger(step.from) &&
          Number.isInteger(step.to)
        ) {
          if (!isValidRange(step.from, step.to, currentMarkdown.length)) {
            throw new Error('delete range is invalid or out of bounds.');
          }
          currentMarkdown = currentMarkdown.slice(0, step.from) + currentMarkdown.slice(step.to);
          applied = true;
        } else if (step?.type === 'replace' && typeof step.text === 'string') {
          currentMarkdown = step.text;
          applied = true;
        }
        if (!applied) throw new Error('unsupported or incomplete delta step.');
        replayedDeltasCount++;
        version += 1;
      } catch (err) {
        const recoveryError: RecoveryError = {
          deltaId: delta.id,
          message: err instanceof Error ? err.message : String(err)
        };
        recoveryErrors.push(recoveryError);
        options.onError?.(recoveryError);
        if (options.strict !== false) {
          throw new Error(`Failed to replay delta${delta.id === undefined ? '' : ` ${delta.id}`}: ${recoveryError.message}`, {
            cause: err
          });
        }
      }
    }

    const contentSize = options.measureContent
      ? options.measureContent(currentMarkdown)
      : currentMarkdown.length;

    return {
      documentId,
      version,
      contentMarkdown: currentMarkdown,
      contentJson: currentJson,
      replayedDeltasCount,
      recoveryErrors,
      contentSize
    };
  }
}

function isValidPosition(position: unknown, length: number): position is number {
  return Number.isInteger(position) && (position as number) >= 0 && (position as number) <= length;
}

function isValidRange(from: unknown, to: unknown, length: number): from is number {
  return (
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    (from as number) >= 0 &&
    (to as number) >= (from as number) &&
    (to as number) <= length
  );
}
