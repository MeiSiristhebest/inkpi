import type { FtsSearchResult } from '@inkpi/protocol';
import type { InkDb } from './db.js';

export interface FtsSearchOptions {
  query: string;
  workspaceId?: string;
  limit?: number;
}

export class FtsSearchEngine {
  private db: InkDb;

  constructor(db: InkDb) {
    this.db = db;
  }

  /**
   * 执行全文检索 (BM25 排序，返回匹配文档与高亮摘要片段，严格支持 workspaceId 隔离 P0.11, INV-03)
   */
  public search(queryOrOptions: string | FtsSearchOptions, limitParam = 20): FtsSearchResult[] {
    const options: FtsSearchOptions =
      typeof queryOrOptions === 'string' ? { query: queryOrOptions, limit: limitParam } : queryOrOptions;

    const trimmed = options.query.trim();
    if (!trimmed) return [];
    const limit = options.limit ?? limitParam;
    const workspaceId = options.workspaceId;

    const formattedQuery = `"${trimmed.replace(/"/g, '""')}"`;
    const ftsSql = workspaceId
      ? `
      SELECT
        f.document_id,
        c.title,
        c.order_index,
        snippet(documents_fts, 2, '<b>', '</b>', '...', 24) AS snippet,
        bm25(documents_fts) AS rank
      FROM documents_fts f
      JOIN documents c ON c.id = f.document_id
      WHERE c.workspace_id = ? AND documents_fts MATCH ?
      ORDER BY rank ASC
      LIMIT ?
    `
      : `
      SELECT
        f.document_id,
        c.title,
        c.order_index,
        snippet(documents_fts, 2, '<b>', '</b>', '...', 24) AS snippet,
        bm25(documents_fts) AS rank
      FROM documents_fts f
      JOIN documents c ON c.id = f.document_id
      WHERE documents_fts MATCH ?
      ORDER BY rank ASC
      LIMIT ?
    `;

    const ftsParams = workspaceId ? [workspaceId, formattedQuery, limit] : [formattedQuery, limit];
    const stmt = this.db.prepare(ftsSql);
    const ftsRows = stmt.all(...ftsParams) as any[];

    if (ftsRows && ftsRows.length > 0) {
      return ftsRows.map((r) => ({
        documentId: r.document_id,
        title: r.title,
        orderIndex: Number(r.order_index),
        snippet: r.snippet || '',
        rank: Number(r.rank)
      }));
    }

    // FTS fallback substring matching (respecting workspaceId)
    const fallbackSql = workspaceId
      ? `
      SELECT 
        s.document_id,
        c.title,
        c.order_index,
        substr(s.content_markdown, 1, 100) AS snippet,
        0 AS rank
      FROM document_snapshots s
      JOIN documents c ON c.id = s.document_id
      WHERE c.workspace_id = ? AND (s.content_markdown LIKE ? OR c.title LIKE ?)
      LIMIT ?
    `
      : `
      SELECT 
        s.document_id,
        c.title,
        c.order_index,
        substr(s.content_markdown, 1, 100) AS snippet,
        0 AS rank
      FROM document_snapshots s
      JOIN documents c ON c.id = s.document_id
      WHERE s.content_markdown LIKE ? OR c.title LIKE ?
      LIMIT ?
    `;

    const likeQuery = `%${trimmed}%`;
    const fallbackParams = workspaceId ? [workspaceId, likeQuery, likeQuery, limit] : [likeQuery, likeQuery, limit];
    const fallbackStmt = this.db.prepare(fallbackSql);
    const fallbackRows = fallbackStmt.all(...fallbackParams) as any[];

    return fallbackRows.map((r) => ({
      documentId: r.document_id,
      title: r.title,
      orderIndex: Number(r.order_index),
      snippet: r.snippet || '',
      rank: 0
    }));
  }

  /**
   * 手动重建指定全书的全文检索索引
   */
  public rebuildIndex(): void {
    this.db.transaction(() => {
      this.db.exec('DELETE FROM documents_fts;');
      this.db.exec(`
        INSERT INTO documents_fts(document_id, title, content)
        SELECT s.document_id, c.title, s.content_markdown
        FROM document_snapshots s
        JOIN documents c ON c.id = s.document_id;
      `);
    });
  }
}
