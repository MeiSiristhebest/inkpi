import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DocumentDelta, DocumentSnapshot, FtsSearchResult, SessionEntry } from '@inkpi/protocol';
import { BackendClosedError } from './errors.js';
import type { ISessionBackend, SessionBackendCapabilities } from './types.js';

/**
 * 纯文件系统单追加写 JSONL 存储适配器 (JsonlSessionBackend)
 * 零 C++ 原生绑定，跨平台无编译分发，适合轻量 CLI、Serverless 与边缘环境。
 */
export class JsonlSessionBackend implements ISessionBackend {
  public readonly name = 'jsonl';
  public readonly capabilities: SessionBackendCapabilities = {
    fts: true,
    snapshots: true,
    concurrencyLeases: false,
    durableDisk: true
  };

  private baseDir: string;
  private closed = false;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new BackendClosedError(this.name);
    }
  }

  public async initialize(): Promise<void> {
    this.assertOpen();
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // No persistent connection to close
  }

  private getSessionJournalPath(sessionId: string): string {
    return path.join(this.baseDir, `session_${sessionId}.jsonl`);
  }

  private getSnapshotsPath(): string {
    return path.join(this.baseDir, 'snapshots.json');
  }

  private getDeltasPath(documentId: string): string {
    return path.join(this.baseDir, `deltas_${documentId}.jsonl`);
  }

  public async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    this.assertOpen();
    const filePath = this.getSessionJournalPath(sessionId);
    const line = `${JSON.stringify(entry)}\n`;
    fs.appendFileSync(filePath, line, 'utf8');
  }

  public async loadEntries(sessionId: string, entries: SessionEntry[]): Promise<void> {
    this.assertOpen();
    if (entries.length === 0) return;
    const filePath = this.getSessionJournalPath(sessionId);
    const lines = entries.map((e) => `${JSON.stringify(e)}\n`).join('');
    fs.appendFileSync(filePath, lines, 'utf8');
  }

  public async getEntries(sessionId: string, fromTimestamp?: number): Promise<SessionEntry[]> {
    this.assertOpen();
    const filePath = this.getSessionJournalPath(sessionId);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const entries: SessionEntry[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as SessionEntry;
        if (fromTimestamp === undefined || parsed.timestamp >= fromTimestamp) {
          entries.push(parsed);
        }
      } catch {
        // Skip malformed trailing lines
      }
    }

    return entries;
  }

  public async saveSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    this.assertOpen();
    const filePath = this.getSnapshotsPath();
    let map: Record<string, DocumentSnapshot> = {};
    if (fs.existsSync(filePath)) {
      try {
        map = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        map = {};
      }
    }
    map[snapshot.documentId] = snapshot;
    fs.writeFileSync(filePath, JSON.stringify(map, null, 2), 'utf8');
  }

  public async getSnapshot(documentId: string): Promise<DocumentSnapshot | null> {
    this.assertOpen();
    const filePath = this.getSnapshotsPath();
    if (!fs.existsSync(filePath)) return null;
    try {
      const map = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return map[documentId] || null;
    } catch {
      return null;
    }
  }

  public async appendDelta(delta: DocumentDelta): Promise<void> {
    this.assertOpen();
    const filePath = this.getDeltasPath(delta.documentId);
    const existing = await this.getDeltas(delta.documentId);
    const nextId = delta.id !== undefined ? delta.id : existing.length + 1;
    const entry = { ...delta, id: nextId };
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  public async getDeltas(documentId: string, fromId?: number): Promise<DocumentDelta[]> {
    this.assertOpen();
    const filePath = this.getDeltasPath(documentId);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const deltas: DocumentDelta[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as DocumentDelta;
        if (fromId === undefined || (parsed.id || 0) >= fromId) {
          deltas.push(parsed);
        }
      } catch {
        // Skip malformed
      }
    }

    return deltas;
  }

  public async search(query: string, limit = 20): Promise<FtsSearchResult[]> {
    this.assertOpen();
    const snapPath = this.getSnapshotsPath();
    if (!fs.existsSync(snapPath)) return [];

    try {
      const map: Record<string, DocumentSnapshot> = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      const results: FtsSearchResult[] = [];
      const lower = query.toLowerCase();
      let idxOrder = 1;

      for (const [docId, snap] of Object.entries(map)) {
        if (snap.contentMarkdown?.toLowerCase().includes(lower)) {
          const idx = snap.contentMarkdown.toLowerCase().indexOf(lower);
          const snippet = snap.contentMarkdown.slice(
            Math.max(0, idx - 20),
            Math.min(snap.contentMarkdown.length, idx + 80)
          );
          results.push({
            documentId: docId,
            title: `Document ${docId}`,
            snippet: snippet.trim(),
            orderIndex: idxOrder++
          });
          if (results.length >= limit) break;
        }
      }
      return results;
    } catch {
      return [];
    }
  }
}
