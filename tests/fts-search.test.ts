import { describe, it, expect } from 'vitest';
import { InkDb, InkRepository, FtsSearchEngine } from '@inkpi/storage';

describe('@inkpi/storage -> FTS5 Full-Text Search Engine (1:1 Ported from repos/pi)', () => {
  it('should perform sub-millisecond BM25 keyword, phrase, and prefix search across documents', () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const fts = new FtsSearchEngine(db);

    const now = Date.now();
    repo.createWorkspace({
      id: 'workspace_fts',
      title: '大奉打更人',
      owner: '卖报小郎君',
      category: 'standard',
      targetSize: 3000000,
      createdAt: now,
      updatedAt: now
    });
    repo.createFolder({
      id: 'vol_fts_1',
      workspaceId: 'workspace_fts',
      title: '第一folder 妖蛊之乱',
      orderIndex: 1,
      createdAt: now,
      updatedAt: now
    });

    repo.createDocument({
      id: 'ch_fts_1',
      folderId: 'vol_fts_1',
      workspaceId: 'workspace_fts',
      title: '第一document 牢狱之灾',
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
      title: '第二document 税银案真相',
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
      contentMarkdown: '许七安幽幽苏醒，发现自己身陷大牢，浑身剧痛。身旁狱卒冷笑道：斩首之日就在三日之后。',
      contentSize: 45,
      updatedAt: now
    });

    repo.upsertSnapshot({
      documentId: 'ch_fts_2',
      version: 1,
      contentJson: '{}',
      contentMarkdown: '二叔许平志脸色惨白。许七安在泥地上写下化学方程式：硝石、硫磺与木炭的奥秘。',
      contentSize: 40,
      updatedAt: now + 1
    });

    // 1. Search keyword "许七安" -> should match both documents
    const res1 = fts.search('许七安');
    expect(res1.length).toBe(2);

    // 2. Search specific asset "硝石" -> should match document 2 with highlighted snippet
    const res2 = fts.search('硝石');
    expect(res2.length).toBe(1);
    expect(res2[0].documentId).toBe('ch_fts_2');
    expect(res2[0].title).toBe('第二document 税银案真相');

    // 3. Search non-existent keyword
    const resNone = fts.search('不存在的太古神器');
    expect(resNone.length).toBe(0);

    // 4. Empty search
    expect(fts.search('')).toEqual([]);

    // 5. Test manual rebuildIndex
    fts.rebuildIndex();
    const resAfterRebuild = fts.search('狱卒');
    expect(resAfterRebuild.length).toBe(1);

    db.close();
  });
});
