import type { DocumentDelta, DocumentSnapshot, FtsSearchResult, SessionEntry } from '@inkpi/protocol';
import { BackendClosedError } from './errors.js';
import type { ISessionBackend, SessionBackendCapabilities } from './types.js';

/**
 * 纯内存无副作用持久化适配器 (MemorySessionBackend)
 * 具备零 I/O、确定性时序与极速执行特性，专门用于单元测试、临时演化推演与无状态网关。
 */
export class MemorySessionBackend implements ISessionBackend {
  public readonly name = 'memory';
  public readonly capabilities: SessionBackendCapabilities = {
    fts: true,
    snapshots: true,
    concurrencyLeases: false,
    durableDisk: false
  };

  private journals = new Map<string, SessionEntry[]>();
  private snapshots = new Map<string, DocumentSnapshot>();
  private deltas = new Map<string, DocumentDelta[]>();
  private initialized = false;
  private closed = false;

  private assertOpen(): void {
    if (this.closed) {
      throw new BackendClosedError(this.name);
    }
  }

  public async initialize(): Promise<void> {
    this.assertOpen();
    this.initialized = true;
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.initialized = false;
    this.closed = true;
    this.journals.clear();
    this.snapshots.clear();
    this.deltas.clear();
  }

  public async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    this.assertOpen();
    if (!this.journals.has(sessionId)) {
      this.journals.set(sessionId, []);
    }
    this.journals.get(sessionId)!.push({ ...entry });
  }

  public async getEntries(sessionId: string, fromTimestamp?: number): Promise<SessionEntry[]> {
    this.assertOpen();
    const list = this.journals.get(sessionId) || [];
    if (fromTimestamp === undefined) {
      return [...list];
    }
    return list.filter((e) => e.timestamp >= fromTimestamp);
  }

  public async saveSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    this.assertOpen();
    this.snapshots.set(snapshot.documentId, { ...snapshot });
  }

  public async getSnapshot(documentId: string): Promise<DocumentSnapshot | null> {
    this.assertOpen();
    const snap = this.snapshots.get(documentId);
    return snap ? { ...snap } : null;
  }

  public async appendDelta(delta: DocumentDelta): Promise<void> {
    this.assertOpen();
    if (!this.deltas.has(delta.documentId)) {
      this.deltas.set(delta.documentId, []);
    }
    const list = this.deltas.get(delta.documentId)!;
    const nextId = delta.id !== undefined ? delta.id : list.length + 1;
    list.push({ ...delta, id: nextId });
  }

  public async getDeltas(documentId: string, fromId?: number): Promise<DocumentDelta[]> {
    this.assertOpen();
    const list = this.deltas.get(documentId) || [];
    if (fromId === undefined) {
      return [...list];
    }
    return list.filter((d) => (d.id || 0) >= fromId);
  }

  public async search(query: string, limit = 20): Promise<FtsSearchResult[]> {
    this.assertOpen();
    const results: FtsSearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    const entries = Array.from(this.snapshots.entries());
    let idxOrder = 1;
    for (const [docId, snap] of entries) {
      if (snap.contentMarkdown?.toLowerCase().includes(lowerQuery)) {
        const idx = snap.contentMarkdown.toLowerCase().indexOf(lowerQuery);
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
