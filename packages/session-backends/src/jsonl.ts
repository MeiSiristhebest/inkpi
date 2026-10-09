import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DocumentDelta, DocumentSnapshot, FtsSearchResult, SessionEntry } from '@inkpi/protocol';
import { BackendClosedError } from './errors.js';
import type { ISessionBackend, SessionBackendCapabilities } from './types.js';

function parseJsonl<T>(content: string, filePath: string): T[] {
  if (!content) return [];

  const endedWithNewline = content.endsWith('\n');
  const lines = content.split('\n');
  if (endedWithNewline) lines.pop();

  const records: T[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;

    try {
      records.push(JSON.parse(line) as T);
    } catch (cause) {
      if (!endedWithNewline && index === lines.length - 1) {
        // A crash can leave only the final append unfinished. It is safe to ignore
        // on read, but writers must not append after it and turn it into interior corruption.
        return records;
      }
      throw new Error(`Corrupt JSONL record in "${filePath}" at line ${index + 1}.`, { cause });
    }
  }

  return records;
}

function appendJsonl(filePath: string, content: string): void {
  let separator = '';
  if (fs.existsSync(filePath)) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      if (size > 0) {
        const lastByte = Buffer.alloc(1);
        fs.readSync(fd, lastByte, 0, 1, size - 1);
        if (lastByte[0] !== 0x0a) {
          let cursor = size;
          let lineStart = 0;
          while (cursor > 0) {
            const length = Math.min(cursor, 4096);
            cursor -= length;
            const chunk = Buffer.alloc(length);
            const bytesRead = fs.readSync(fd, chunk, 0, length, cursor);
            const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
            if (newline >= 0) {
              lineStart = cursor + newline + 1;
              break;
            }
          }

          const tailLength = size - lineStart;
          const tail = Buffer.alloc(tailLength);
          fs.readSync(fd, tail, 0, tailLength, lineStart);
          try {
            JSON.parse(tail.toString('utf8'));
          } catch (cause) {
            throw new Error(`Cannot append to "${filePath}": its final JSONL record is incomplete.`, { cause });
          }
          separator = '\n';
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  fs.appendFileSync(filePath, `${separator}${content}`, 'utf8');
}

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
    appendJsonl(filePath, line);
  }

  public async loadEntries(sessionId: string, entries: SessionEntry[]): Promise<void> {
    this.assertOpen();
    if (entries.length === 0) return;
    const filePath = this.getSessionJournalPath(sessionId);
    const lines = entries.map((e) => `${JSON.stringify(e)}\n`).join('');
    appendJsonl(filePath, lines);
  }

  public async getEntries(sessionId: string, fromTimestamp?: number): Promise<SessionEntry[]> {
    this.assertOpen();
    const filePath = this.getSessionJournalPath(sessionId);
    if (!fs.existsSync(filePath)) return [];

    const records = parseJsonl<SessionEntry>(fs.readFileSync(filePath, 'utf8'), filePath);
    return fromTimestamp === undefined ? records : records.filter((entry) => entry.timestamp >= fromTimestamp);
  }

  private readSnapshots(): Record<string, DocumentSnapshot> | null {
    const filePath = this.getSnapshotsPath();
    if (!fs.existsSync(filePath)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (cause) {
      throw new Error(`Snapshot file "${filePath}" is corrupt and was not modified.`, { cause });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Snapshot file "${filePath}" must contain a JSON object.`);
    }
    return parsed as Record<string, DocumentSnapshot>;
  }

  public async saveSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    this.assertOpen();
    const filePath = this.getSnapshotsPath();
    const map = this.readSnapshots() ?? {};
    map[snapshot.documentId] = snapshot;
    fs.writeFileSync(filePath, JSON.stringify(map, null, 2), 'utf8');
  }

  public async getSnapshot(documentId: string): Promise<DocumentSnapshot | null> {
    this.assertOpen();
    const map = this.readSnapshots();
    return map?.[documentId] ?? null;
  }

  public async appendDelta(delta: DocumentDelta): Promise<void> {
    this.assertOpen();
    const filePath = this.getDeltasPath(delta.documentId);
    const existing = await this.getDeltas(delta.documentId);
    const nextId = delta.id !== undefined ? delta.id : existing.length + 1;
    const entry = { ...delta, id: nextId };
    appendJsonl(filePath, `${JSON.stringify(entry)}\n`);
  }

  public async getDeltas(documentId: string, fromId?: number): Promise<DocumentDelta[]> {
    this.assertOpen();
    const filePath = this.getDeltasPath(documentId);
    if (!fs.existsSync(filePath)) return [];

    const records = parseJsonl<DocumentDelta>(fs.readFileSync(filePath, 'utf8'), filePath);
    return fromId === undefined ? records : records.filter((delta) => (delta.id || 0) >= fromId);
  }

  public async search(query: string, limit = 20): Promise<FtsSearchResult[]> {
    this.assertOpen();
    const map = this.readSnapshots();
    if (!map) return [];

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
  }
}
