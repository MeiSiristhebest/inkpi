import { describe, it, expect } from 'vitest';
import { InkDb, InkRepository, AppendOnlySessionJournal } from '@inkpi/storage';

describe('Append-Only JSONL Session Storage & Event Sourcing', () => {
  it('should append immutable journal events and query by type', () => {
    const journal = new AppendOnlySessionJournal('session_novel_101');
    expect(journal.sessionId).toBe('session_novel_101');
    expect(journal.count()).toBe(0);

    journal.append('session_start', { book: { id: 'workspace_1', title: '万古仙穹', owner: '无名氏', category: '仙侠', targetSize: 1000000, createdAt: Date.now(), updatedAt: Date.now() } });
    journal.append('user_message', { content: '请推演第十document' });
    journal.append('draft_revision', { documentId: 'ch_1', markdown: '天地不仁，以万物为刍狗。' });
    journal.append('pipeline_stage', { stage: 'outline', role: 'architect' });

    expect(journal.count()).toBe(4);
    expect(journal.getEntriesByType('draft_revision').length).toBe(1);
    expect(journal.getEntriesByType('user_message').length).toBe(1);
  });

  it('should export to standard JSONL and import seamlessly', () => {
    const journal1 = new AppendOnlySessionJournal('session_export_test');
    journal1.append('user_message', { text: '第一条消息' });
    journal1.append('agent_turn', { text: '第一条回复' });

    const jsonl = journal1.exportToJsonl();
    expect(jsonl).toContain('第一条消息');
    expect(jsonl.split('\n').length).toBe(2);

    const journal2 = new AppendOnlySessionJournal('session_export_test');
    const importedCount = journal2.importFromJsonl(jsonl + '\n{invalid json}\n\n');
    expect(importedCount).toBe(2);
    expect(journal2.count()).toBe(2);
  });

  it('should replay journal events into SQLite repository as materialized view projection', () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);

    const journal = new AppendOnlySessionJournal('session_replay_test');
    journal.append('session_start', {
      book: {
        id: 'workspace_replay',
        title: 'Test Workspace Name',
        owner: '剑客',
        category: '玄幻',
        targetSize: 500000,
        createdAt: Date.now(),
        updatedAt: Date.now()
      },
      folders: [
        { id: 'vol_1', workspaceId: 'workspace_replay', title: '第一folder', orderIndex: 1, createdAt: Date.now(), updatedAt: Date.now() }
      ],
      documents: [
        { id: 'ch_1', folderId: 'vol_1', workspaceId: 'workspace_replay', title: '第一document 觉醒', orderIndex: 1, contentSize: 0, status: 'draft', createdAt: Date.now(), updatedAt: Date.now() }
      ]
    });

    journal.append('draft_revision', {
      documentId: 'ch_1',
      markdown: '少年UserB盘坐于青石之上，吞吐天地灵气。'
    });

    journal.append('ledger_mutation', {
      ledger: {
        entities: [{ name: 'UserB', status: '练气一层' }],
        assets: [],
        tracks: [],
        locations: [],
        modifiedDocuments: ['第一document 觉醒']
      }
    });

    journal.append('compaction', {
      id: 'comp_1',
      summary: '阶段总结',
      tokensBefore: 5000,
      estimatedTokensAfter: 1000,
      details: { stateLedger: { entities: [], assets: [], tracks: [], locations: [], modifiedDocuments: [] } }
    });

    const singleEntry = journal.getEntry('non_existent');
    expect(singleEntry).toBeUndefined();

    const replayRes = journal.replayToDb(repo, db);
    expect(replayRes.replayedCount).toBe(4);
    expect(replayRes.snapshotsCreated).toBe(1);

    // Verify SQLite projection
    const workspaceInDb = repo.getWorkspace('workspace_replay');
    expect(workspaceInDb?.title).toBe('Test Workspace Name');

    const snap = repo.getSnapshot('ch_1');
    expect(snap?.contentMarkdown).toContain('少年UserB');
    expect(snap?.contentSize).toBeGreaterThan(0);

    db.close();
  });
});
