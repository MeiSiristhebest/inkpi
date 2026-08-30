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
    repo.createWorkspace({ id: 'workspace_jit', title: 'Cosmic Frontier', owner: 'Author Mei', category: 'general', targetSize: 2000000, createdAt: Date.now(), updatedAt: Date.now() });
    repo.createFolder({ id: 'vol_1', workspaceId: 'workspace_jit', title: 'Folder 1 Space Odyssey', orderIndex: 1, createdAt: Date.now(), updatedAt: Date.now() });

    // Document 1
    repo.createDocument({ id: 'ch_1', folderId: 'vol_1', workspaceId: 'workspace_jit', title: 'Document 1 Genesis', orderIndex: 1, synopsis: 'Starship discovers ancient artifact.', contentSize: 3000, status: 'completed', createdAt: Date.now(), updatedAt: Date.now() });
    repo.upsertSnapshot({ documentId: 'ch_1', version: 1, contentJson: '{}', contentMarkdown: 'Commander Alice discovers the Quantum Beacon. Secret encryption module holds vital navigation data.', contentSize: 30, updatedAt: Date.now() });

    // Document 2
    repo.createDocument({ id: 'ch_2', folderId: 'vol_1', workspaceId: 'workspace_jit', title: 'Document 2 Orbit Approach', orderIndex: 2, synopsis: 'Crew approaches alien planetary ring.', contentSize: 3000, status: 'completed', createdAt: Date.now(), updatedAt: Date.now() });
    repo.upsertSnapshot({ documentId: 'ch_2', version: 1, contentJson: '{}', contentMarkdown: 'Beacon emits signal pulse, alien sentinels activate defensive protocols.', contentSize: 25, updatedAt: Date.now() });

    // Document 3 (Current)
    repo.createDocument({ id: 'ch_3', folderId: 'vol_1', workspaceId: 'workspace_jit', title: 'Document 3 Planetfall', orderIndex: 3, synopsis: 'Landing on uncharted planet surface.', contentSize: 0, status: 'draft', createdAt: Date.now(), updatedAt: Date.now() });

    // Rebuild FTS index
    fts.rebuildIndex();

    // Query JIT memory for Document 3
    const result = await jit.retrieve(
      {
        workspaceId: 'workspace_jit',
        currentDocumentId: 'ch_3',
        currentDraftText: 'Alice holds the Quantum Beacon, examining the ancient ruins.',
        activeEntities: ['Alice', 'Quantum Beacon']
      },
      {
        entities: [{ name: 'Alice', status: 'Captain' }, { name: 'Bob', status: 'Engineer' }],
        assets: [{ name: 'Quantum Beacon', holder: 'Alice' }],
        tracks: [{ clue: 'Signal points to coordinates Omega', status: 'pending' }],
        locations: [{ name: 'Planet Surface' }],
        modifiedDocuments: ['Document 1 Genesis', 'Document 2 Orbit Approach']
      }
    );

    // Assert L1
    expect(result.l1WorkingMemory.activeEntities).toContain('Alice');
    expect(result.l1WorkingMemory.activeAssets).toContain('Quantum Beacon');

    // Assert L2
    expect(result.l2RecentSummaries.length).toBe(2);
    expect(result.l2RecentSummaries[0].title).toBe('Document 1 Genesis');

    // Assert L3
    expect(result.l3GlobalLore.length).toBeGreaterThan(0);

    // Assert assembled prompt block
    expect(result.assembledPromptBlock).toContain('L1 Working Memory');
    expect(result.assembledPromptBlock).toContain('L2 Document Chain');
    expect(result.assembledPromptBlock).toContain('L3 Global Lore');

    db.close();
  });
});
