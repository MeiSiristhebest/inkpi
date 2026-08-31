import type {
  DocumentSnapshot,
  DocumentDelta,
  FtsSearchResult,
  SessionEntry
} from '@meisiristhebest/protocol';
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

  public async initialize(): Promise<void> {
    this.initialized = true;
  }

  public async close(): Promise<void> {
    this.initialized = false;
    this.journals.clear();
    this.snapshots.clear();
    this.deltas.clear();
  }

  public async appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    if (!this.journals.has(sessionId)) {
      this.journals.set(sessionId, []);
    }
    this.journals.get(sessionId)!.push({ ...entry });
  }

  public async getEntries(sessionId: string, fromTimestamp?: number): Promise<SessionEntry[]> {
    const list = this.journals.get(sessionId) || [];
    if (fromTimestamp === undefined) {
      return [...list];
    }
    return list.filter((e) => e.timestamp >= fromTimestamp);
  }

  public async saveSnapshot(snapshot: DocumentSnapshot): Promise<void> {
    this.snapshots.set(snapshot.documentId, { ...snapshot });
  }

  public async getSnapshot(documentId: string): Promise<DocumentSnapshot | null> {
    const snap = this.snapshots.get(documentId);
    return snap ? { ...snap } : null;
  }

  public async appendDelta(delta: DocumentDelta): Promise<void> {
    if (!this.deltas.has(delta.documentId)) {
      this.deltas.set(delta.documentId, []);
    }
    const list = this.deltas.get(delta.documentId)!;
    const nextId = (delta.id !== undefined ? delta.id : list.length + 1);
    list.push({ ...delta, id: nextId });
  }

  public async getDeltas(documentId: string, fromId?: number): Promise<DocumentDelta[]> {
    const list = this.deltas.get(documentId) || [];
    if (fromId === undefined) {
      return [...list];
    }
    return list.filter((d) => (d.id || 0) >= fromId);
  }

  public async search(query: string, limit = 20): Promise<FtsSearchResult[]> {
    const results: FtsSearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    const entries = Array.from(this.snapshots.entries());
    let idxOrder = 1;
    for (const [docId, snap] of entries) {
      if (snap.contentMarkdown && snap.contentMarkdown.toLowerCase().includes(lowerQuery)) {
        const idx = snap.contentMarkdown.toLowerCase().indexOf(lowerQuery);
        const snippet = snap.contentMarkdown.slice(Math.max(0, idx - 20), Math.min(snap.contentMarkdown.length, idx + 80));
        results.push({
          documentId: docId,
          title: `Document ${docId}`,
          snippet: snippet.trim(),
          rank: -1,
          orderIndex: idxOrder++
        });
        if (results.length >= limit) break;
      }
    }

    return results;
  }
}
