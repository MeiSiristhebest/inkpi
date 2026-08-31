import { describe, it, expect } from 'vitest';
import {
  InkDb,
  InkRepository,
  FtsSearchEngine,
  JitMemoryRetriever,
  formatJitContextAsPrompt
} from '@inkpi/storage';

describe('JIT Tiered Memory Retrieval (L1 / L2 / L3)', () => {
  it('should return structured retrieval data without imposing a content format', async () => {
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
        currentText: 'Alice holds the Quantum Beacon, examining the ancient ruins.',
        activeReferences: ['Alice', 'Quantum Beacon']
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
    expect(result.l1WorkingMemory.activeReferences).toEqual(['Alice', 'Quantum Beacon']);

    // Assert L2
    expect(result.l2RecentSummaries.length).toBe(2);
    expect(result.l2RecentSummaries[0].title).toBe('Document 1 Genesis');

    // Assert L3
    expect(result.l3GlobalLore.length).toBeGreaterThan(0);

    // Formatting is opt-in. The core result must remain usable by any modality.
    expect(result.assembledPromptBlock).toBe('');

    db.close();
  });

  it('should use an explicit formatter and keyword selector', async () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const fts = new FtsSearchEngine(db);
    repo.createWorkspace({ id: 'workspace_custom', title: 'Workspace', owner: 'Owner', createdAt: Date.now(), updatedAt: Date.now() });
    repo.createFolder({ id: 'folder_custom', workspaceId: 'workspace_custom', title: 'Folder', orderIndex: 1, createdAt: Date.now(), updatedAt: Date.now() });
    repo.createDocument({ id: 'doc_custom', folderId: 'folder_custom', workspaceId: 'workspace_custom', title: 'Document', orderIndex: 1, contentSize: 0, status: 'draft', createdAt: Date.now(), updatedAt: Date.now() });
    repo.upsertSnapshot({ documentId: 'doc_custom', version: 1, contentJson: '{}', contentMarkdown: 'Signal appears here.', contentSize: 19, updatedAt: Date.now() });
    fts.rebuildIndex();

    const result = await new JitMemoryRetriever({
      repository: repo,
      ftsEngine: fts,
      keywordSelector: () => ['Signal'],
      formatContext: (structured) => `CUSTOM:${structured.l3GlobalLore.map((item) => item.documentId).join(',')}`
    }).retrieve({ workspaceId: 'workspace_custom' });

    expect(result.l3GlobalLore.map((item) => item.documentId)).toEqual(['doc_custom']);
    expect(result.assembledPromptBlock).toBe('CUSTOM:doc_custom');

    const explicitText = formatJitContextAsPrompt(result);
    expect(explicitText).toContain('Retrieved Context');
    expect(explicitText).toContain('Document');

    // Comprehensive formatJitContextAsPrompt branches
    const formattedFull = formatJitContextAsPrompt({
      l1WorkingMemory: {
        activeEntities: ['Alice'],
        activeAssets: ['Sword'],
        activeTracks: ['t1'],
        activeReferences: [],
        activeLedger: {
          entities: [{ name: 'Alice', status: 'Active' }, { name: 'Bob' }],
          assets: [{ name: 'Sword', holder: 'Alice' }, { name: 'Shield' }],
          tracks: [
            { summary: 'Summary track', status: 'done' },
            { id: 'track_id_only' },
            { status: 'open' }
          ],
          locations: [],
          modifiedResources: []
        }
      },
      l2RecentSummaries: [{ documentId: 'doc1', title: 'Chapter 1', summary: 'Summary 1' }],
      l3GlobalLore: [{ documentId: 'doc2', title: 'Chapter 2', orderIndex: 2, snippet: 'Snippet 2', rank: 1 }]
    });
    expect(formattedFull).toContain('Entities: Alice(Active), Bob');
    expect(formattedFull).toContain('Assets: Sword[Holder:Alice], Shield');
    expect(formattedFull).toContain('Tracks: Summary track(done); track_id_only; track(open)');
    expect(formattedFull).toContain('=== Recent Document Summaries ===');
    expect(formattedFull).toContain('=== Full-Text Matches ===');

    db.close();
  });

  it('should apply the configured FTS search error policy', async () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const failingFts = { search: () => { throw new Error('index unavailable'); } } as unknown as FtsSearchEngine;

    await expect(new JitMemoryRetriever({
      repository: repo,
      ftsEngine: failingFts,
      keywordSelector: () => ['term']
    }).retrieve({})).rejects.toThrow('index unavailable');

    const ignored = await new JitMemoryRetriever({
      repository: repo,
      ftsEngine: failingFts,
      keywordSelector: () => ['term'],
      onSearchError: 'ignore'
    }).retrieve({});
    expect(ignored.l3GlobalLore).toEqual([]);

    const errors: string[] = [];
    await new JitMemoryRetriever({
      repository: repo,
      ftsEngine: failingFts,
      keywordSelector: () => ['term'],
      onSearchError: (error, keyword) => errors.push(`${keyword}:${(error as Error).message}`)
    }).retrieve({});
    expect(errors).toEqual(['term:index unavailable']);
    db.close();
  });
});
