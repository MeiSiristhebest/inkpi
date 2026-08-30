import { describe, it, expect } from 'vitest';
import {
  InkDb,
  InkRepository,
  FtsSearchEngine,
  JitMemoryRetriever
} from '@inkpi/storage';

describe('JIT Tiered Memory Retrieval (L1 / L2 / L3)', () => {
  it('should retrieve working memory (L1), recent summaries (L2) and global FTS5 lore (L3)', async () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const fts = new FtsSearchEngine(db);
    const jit = new JitMemoryRetriever({ repository: repo, ftsEngine: fts });

    // Seed workspace, folders, documents
    repo.createWorkspace({ id: 'workspace_jit', title: '遮天纪元', owner: '辰东', category: '仙侠', targetSize: 2000000, createdAt: Date.now(), updatedAt: Date.now() });
    repo.createFolder({ id: 'vol_1', workspaceId: 'workspace_jit', title: '星空古路folder', orderIndex: 1, createdAt: Date.now(), updatedAt: Date.now() });

    // Document 1
    repo.createDocument({ id: 'ch_1', folderId: 'vol_1', workspaceId: 'workspace_jit', title: '第一document 九龙拉棺', orderIndex: 1, synopsis: '泰山之巅九龙拉棺降临。', contentSize: 3000, status: 'completed', createdAt: Date.now(), updatedAt: Date.now() });
    repo.upsertSnapshot({ documentId: 'ch_1', version: 1, contentJson: '{}', contentMarkdown: '青铜巨棺从天而降，荒古圣体叶凡初遇大变。太虚神甲与青铜古灯暗藏玄机。', contentSize: 30, updatedAt: Date.now() });

    // Document 2
    repo.createDocument({ id: 'ch_2', folderId: 'vol_1', workspaceId: 'workspace_jit', title: '第二document 荧惑古星', orderIndex: 2, synopsis: '众人降临火星大雷音寺。', contentSize: 3000, status: 'completed', createdAt: Date.now(), updatedAt: Date.now() });
    repo.upsertSnapshot({ documentId: 'ch_2', version: 1, contentJson: '{}', contentMarkdown: '大雷音寺牌匾破碎，鳄祖破封而出，众人仓皇逃遁。', contentSize: 25, updatedAt: Date.now() });

    // Document 3 (Current)
    repo.createDocument({ id: 'ch_3', folderId: 'vol_1', workspaceId: 'workspace_jit', title: '第三document 荒古禁地', orderIndex: 3, synopsis: '降临北斗星域荒古禁地。', contentSize: 0, status: 'draft', createdAt: Date.now(), updatedAt: Date.now() });

    // Rebuild FTS index
    fts.rebuildIndex();

    // Query JIT memory for Document 3
    const result = await jit.retrieve(
      {
        workspaceId: 'workspace_jit',
        currentDocumentId: 'ch_3',
        currentDraftText: '叶凡手握青铜古灯，凝视荒古禁地的神泉。',
        activeEntities: ['叶凡', '青铜古灯']
      },
      {
        entities: [{ name: '叶凡', status: '苦海境' }, { name: '庞博', status: '妖族血脉' }],
        assets: [{ name: '青铜古灯', holder: '叶凡' }],
        tracks: [{ clue: '九龙拉棺终点指向仙路', status: 'pending' }],
        locations: [{ name: '荒古禁地' }],
        modifiedDocuments: ['第一document 九龙拉棺', '第二document 荧惑古星']
      }
    );

    // Assert L1
    expect(result.l1WorkingMemory.activeEntities).toContain('叶凡');
    expect(result.l1WorkingMemory.activeAssets).toContain('青铜古灯');

    // Assert L2
    expect(result.l2RecentSummaries.length).toBe(2);
    expect(result.l2RecentSummaries[0].title).toBe('第一document 九龙拉棺');

    // Assert L3
    expect(result.l3GlobalLore.length).toBeGreaterThan(0);

    // Assert assembled prompt block
    expect(result.assembledPromptBlock).toContain('L1 Working Memory');
    expect(result.assembledPromptBlock).toContain('L2 Document Chain');
    expect(result.assembledPromptBlock).toContain('L3 Global Lore');

    db.close();
  });
});
