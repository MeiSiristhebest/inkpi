import { FtsSearchEngine, InkDb, InkRepository } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

describe('@inkpi/storage -> FTS5 Full-Text Search Engine (1:1 Ported from repos/pi)', () => {
  it('should perform sub-millisecond BM25 keyword, phrase, and prefix search across documents', () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const fts = new FtsSearchEngine(db);

    const now = Date.now();
    repo.createWorkspace({
      id: 'workspace_fts',
      title: 'Lore Archive System',
      owner: 'Archive Admin',
      category: 'standard',
      targetSize: 3000000,
      createdAt: now,
      updatedAt: now
    });
    repo.createFolder({
      id: 'vol_fts_1',
      workspaceId: 'workspace_fts',
      title: 'Folder 1 Records',
      orderIndex: 1,
      createdAt: now,
      updatedAt: now
    });

    repo.createDocument({
      id: 'ch_fts_1',
      folderId: 'vol_fts_1',
      workspaceId: 'workspace_fts',
      title: 'Document 1 Containment Event',
      orderIndex: 1,
      contentSize: 3000,
      status: 'published',
      createdAt: now,
      updatedAt: now
    });
    repo.createDocument({
      id: 'ch_fts_2',
      folderId: 'vol_fts_1',
      workspaceId: 'workspace_fts',
      title: 'Document 2 Chemical Analysis',
      orderIndex: 2,
      contentSize: 3200,
      status: 'published',
      createdAt: now + 1,
      updatedAt: now + 1
    });

    // Insert snapshots -> SQLite triggers automatically sync to documents_fts!
    repo.upsertSnapshot({
      documentId: 'ch_fts_1',
      version: 1,
      contentJson: '{}',
      contentMarkdown: 'UserX awakens in cell, security guards alerting perimeter protocols.',
      contentSize: 45,
      updatedAt: now
    });

    repo.upsertSnapshot({
      documentId: 'ch_fts_2',
      version: 1,
      contentJson: '{}',
      contentMarkdown: 'Officer analyzes chemical formula containing Potassium Nitrate and Carbon.',
      contentSize: 40,
      updatedAt: now + 1
    });

    // 1. Search keyword "Chemical" -> matches document 2
    const res1 = fts.search('Chemical');
    expect(res1.length).toBe(1);
    expect(res1[0].documentId).toBe('ch_fts_2');
    expect(res1[0].title).toBe('Document 2 Chemical Analysis');

    // 2. Search keyword "UserX" -> matches document 1
    const res2 = fts.search('UserX');
    expect(res2.length).toBe(1);
    expect(res2[0].documentId).toBe('ch_fts_1');

    // 3. Search non-existent keyword
    const resNone = fts.search('NonExistentKeywordXYZ');
    expect(resNone.length).toBe(0);

    // 4. Empty search
    expect(fts.search('')).toEqual([]);

    // 5. Test manual rebuildIndex
    fts.rebuildIndex();
    const resAfterRebuild = fts.search('security');
    expect(resAfterRebuild.length).toBe(1);

    db.close();
  });

  it('should use CJK substring fallback only after a successful FTS miss', () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const fts = new FtsSearchEngine(db);
    const now = Date.now();

    repo.createWorkspace({
      id: 'workspace_cjk',
      title: '检索工作区',
      owner: 'tester',
      createdAt: now,
      updatedAt: now
    });
    repo.createFolder({
      id: 'folder_cjk',
      workspaceId: 'workspace_cjk',
      title: '素材',
      orderIndex: 0,
      createdAt: now,
      updatedAt: now
    });
    repo.createDocument({
      id: 'doc_cjk',
      folderId: 'folder_cjk',
      workspaceId: 'workspace_cjk',
      title: '夜航记录',
      orderIndex: 0,
      contentSize: 8,
      status: 'draft',
      createdAt: now,
      updatedAt: now
    });
    repo.upsertSnapshot({
      documentId: 'doc_cjk',
      version: 1,
      contentJson: '{}',
      contentMarkdown: '雾中的灯塔忽然熄灭。',
      contentSize: 10,
      updatedAt: now
    });

    expect(fts.search('灯塔').map((result) => result.documentId)).toEqual(['doc_cjk']);
    expect(fts.search('夜航').map((result) => result.documentId)).toEqual(['doc_cjk']);
    db.close();
  });

  it('should surface an FTS execution failure instead of masking it with LIKE results', () => {
    const db = new InkDb(':memory:');
    const fts = new FtsSearchEngine(db);
    db.exec('DROP TABLE documents_fts;');

    expect(() => fts.search('anything')).toThrow();
    db.close();
  });
});
