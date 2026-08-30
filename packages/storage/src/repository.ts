import type { Workspace, Folder, Document, DocumentSnapshot, DocumentDelta } from '@inkpi/protocol';
import type { InkDb } from './db.js';

export class InkRepository {
  private db: InkDb;

  constructor(db: InkDb) {
    this.db = db;
  }

  public createWorkspace(ws: Workspace): void {
    const stmt = this.db.prepare(`
      INSERT INTO workspaces (id, title, owner, category, target_size, synopsis, cover_image, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const metaStr = ws.metadata ? JSON.stringify(ws.metadata) : null;
    stmt.run(
      ws.id,
      ws.title,
      ws.owner,
      ws.category || 'general',
      ws.targetSize || 0,
      ws.description || null,
      ws.coverImage || null,
      metaStr,
      ws.createdAt,
      ws.updatedAt
    );
  }

  public getWorkspace(id: string): Workspace | undefined {
    const stmt = this.db.prepare(`SELECT * FROM workspaces WHERE id = ?`);
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    let meta: Record<string, unknown> | undefined;
    if (row.metadata) {
      try {
        meta = JSON.parse(row.metadata);
      } catch {
        meta = undefined;
      }
    }
    return {
      id: row.id,
      title: row.title,
      owner: row.owner,
      category: row.category,
      targetSize: Number(row.target_size),
      description: row.synopsis,
      coverImage: row.cover_image,
      metadata: meta,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  public createFolder(volume: Folder): void {
    const stmt = this.db.prepare(`
      INSERT INTO folders (id, workspace_id, title, order_index, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      volume.id,
      volume.workspaceId,
      volume.title,
      volume.orderIndex,
      volume.summary || null,
      volume.createdAt,
      volume.updatedAt
    );
  }

  public getFolders(workspaceId: string): Folder[] {
    const stmt = this.db.prepare(`SELECT * FROM folders WHERE workspace_id = ? ORDER BY order_index ASC`);
    const rows = stmt.all(workspaceId) as any[];
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      title: r.title,
      orderIndex: Number(r.order_index),
      summary: r.summary,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    }));
  }

  public createDocument(chapter: Document): void {
    const stmt = this.db.prepare(`
      INSERT INTO documents (id, folder_id, workspace_id, title, order_index, synopsis, content_size, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      chapter.id,
      chapter.folderId,
      chapter.workspaceId,
      chapter.title,
      chapter.orderIndex,
      chapter.synopsis || null,
      chapter.contentSize,
      chapter.status,
      chapter.createdAt,
      chapter.updatedAt
    );
  }

  public getDocument(id: string): Document | undefined {
    const stmt = this.db.prepare(`SELECT * FROM documents WHERE id = ?`);
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      folderId: row.folder_id,
      workspaceId: row.workspace_id,
      title: row.title,
      orderIndex: Number(row.order_index),
      synopsis: row.synopsis,
      contentSize: Number(row.content_size),
      status: row.status,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  public getDocuments(folderId: string): Document[] {
    const stmt = this.db.prepare(`SELECT * FROM documents WHERE folder_id = ? ORDER BY order_index ASC`);
    const rows = stmt.all(folderId) as any[];
    return rows.map((r) => ({
      id: r.id,
      folderId: r.folder_id,
      workspaceId: r.workspace_id,
      title: r.title,
      orderIndex: Number(r.order_index),
      synopsis: r.synopsis,
      contentSize: Number(r.content_size),
      status: r.status,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    }));
  }

  public appendDelta(delta: DocumentDelta): number {
    const stmt = this.db.prepare(`
      INSERT INTO document_deltas (document_id, step_json, client_timestamp, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const res = stmt.run(delta.documentId, delta.stepJson, delta.clientTimestamp, delta.createdAt);
    return Number(res.lastInsertRowid);
  }

  public getDeltas(documentId: string, afterTimestamp = 0): DocumentDelta[] {
    const stmt = this.db.prepare(`
      SELECT * FROM document_deltas
      WHERE document_id = ? AND created_at > ?
      ORDER BY created_at ASC, id ASC
    `);
    const rows = stmt.all(documentId, afterTimestamp) as any[];
    return rows.map((r) => ({
      id: Number(r.id),
      documentId: r.document_id,
      stepJson: r.step_json,
      clientTimestamp: Number(r.client_timestamp),
      createdAt: Number(r.created_at)
    }));
  }

  public deleteDeltas(documentId: string, upToTimestamp: number): number {
    const stmt = this.db.prepare(`
      DELETE FROM document_deltas
      WHERE document_id = ? AND created_at <= ?
    `);
    const res = stmt.run(documentId, upToTimestamp);
    return Number(res.changes);
  }

  public upsertSnapshot(snapshot: DocumentSnapshot): void {
    const stmt = this.db.prepare(`
      INSERT INTO document_snapshots (document_id, version, content_json, content_markdown, content_size, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        version = excluded.version,
        content_json = excluded.content_json,
        content_markdown = excluded.content_markdown,
        content_size = excluded.content_size,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      snapshot.documentId,
      snapshot.version,
      snapshot.contentJson,
      snapshot.contentMarkdown,
      snapshot.contentSize,
      snapshot.updatedAt
    );
  }

  public getSnapshot(documentId: string): DocumentSnapshot | undefined {
    const stmt = this.db.prepare(`SELECT * FROM document_snapshots WHERE document_id = ?`);
    const row = stmt.get(documentId) as any;
    if (!row) return undefined;
    return {
      documentId: row.document_id,
      version: Number(row.version),
      contentJson: row.content_json,
      contentMarkdown: row.content_markdown,
      contentSize: Number(row.content_size),
      updatedAt: Number(row.updated_at)
    };
  }
}
