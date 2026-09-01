import type { FtsSearchResult } from '@inkpi/protocol';
import type { InkDb } from './db.js';

export class FtsSearchEngine {
  private db: InkDb;

  constructor(db: InkDb) {
    this.db = db;
  }

  /**
   * 执行全文检索 (BM25 排序，返回匹配文档与高亮摘要片段)
   */
  public search(query: string, limit = 20): FtsSearchResult[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const formattedQuery = `"${trimmed.replace(/"/g, '""')}"`;
    const stmt = this.db.prepare(`
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
    `);

    const ftsRows = stmt.all(formattedQuery, limit) as any[];
    if (ftsRows && ftsRows.length > 0) {
      return ftsRows.map((r) => ({
        documentId: r.document_id,
        title: r.title,
        orderIndex: Number(r.order_index),
        snippet: r.snippet || '',
        rank: Number(r.rank)
      }));
    }

    // FTS completed successfully but found nothing. This fallback supports
    // substring matching for scripts whose tokenization is not useful here.
    const fallbackStmt = this.db.prepare(`
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
    `);

    const likeQuery = `%${trimmed}%`;
    const fallbackRows = fallbackStmt.all(likeQuery, likeQuery, limit) as any[];
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
      this.db.exec(`DELETE FROM documents_fts;`);
      this.db.exec(`
        INSERT INTO documents_fts(document_id, title, content)
        SELECT s.document_id, c.title, s.content_markdown
        FROM document_snapshots s
        JOIN documents c ON c.id = s.document_id;
      `);
    });
  }
}
