import { describe, it, expect } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InkDb, InkRepository, AppendOnlySessionJournal } from '@meisiristhebest/storage';

describe('Append-Only JSONL Session Storage & Event Sourcing', () => {
  it('should append immutable journal events and query by type', () => {
    const journal = new AppendOnlySessionJournal('session_novel_101');
    expect(journal.sessionId).toBe('session_novel_101');
    expect(journal.count()).toBe(0);

    const root = journal.append('session_start', { scope: 'workspace' }, 'root');
    const message = journal.append('user_message', { content: '请执行任务' });
    const branch = journal.append('custom', { branch: true }, 'branch', root.id);

    expect(journal.count()).toBe(3);
    expect(root).toMatchObject({ seq: 1, parentId: null });
    expect(message).toMatchObject({ seq: 2, parentId: 'root' });
    expect(branch).toMatchObject({ seq: 3, parentId: 'root' });
    expect(journal.getEntriesByType('custom').length).toBe(1);
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
    expect(() => journal2.importFromJsonl(jsonl + '\n{invalid json}\n\n')).toThrow(/line 3/);
    expect(journal2.count()).toBe(2);
    const journal3 = new AppendOnlySessionJournal('session_export_test');
    const importedCount = journal3.importFromJsonl(jsonl + '\n{invalid json}\n\n', { strict: false });
    expect(importedCount).toBe(2);
    expect(journal3.count()).toBe(2);
    expect(journal3.getEntries()).toEqual(journal1.getEntries());
  });

  it('should reject invalid sequence and parent placement during import', () => {
    const journal = new AppendOnlySessionJournal('session_validation_test');
    journal.append('custom', { value: 'root' }, 'root');

    const invalidSeq = JSON.stringify({
      id: 'child',
      sessionId: 'session_validation_test',
      seq: 1,
      parentId: 'root',
      type: 'custom',
      timestamp: 1000,
      payload: {}
    });
    expect(() => journal.importFromJsonl(invalidSeq)).toThrow(/expected seq 2|non-increasing/);

    const invalidParent = JSON.stringify({
      id: 'child',
      sessionId: 'session_validation_test',
      seq: 2,
      parentId: 'missing',
      type: 'custom',
      timestamp: 1000,
      payload: {}
    });
    expect(() => journal.importFromJsonl(invalidParent)).toThrow(/unknown parent/);
    expect(journal.count()).toBe(1);
  });

  it('should replay journal events into SQLite repository as materialized view projection', () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);

    const journal = new AppendOnlySessionJournal('session_replay_test');
    journal.append('session_start', {
      workspace: {
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

    journal.append('operation_intent', {
      id: 'op_replay_1',
      type: 'tool_call',
      intent: { tool: 'grep' }
    });

    journal.append('operation_settlement', {
      id: 'op_replay_1',
      type: 'tool_call',
      settlement: { count: 10 }
    });

    const singleEntry = journal.getEntry('non_existent');
    expect(singleEntry).toBeUndefined();

    const replayRes = journal.replayToDb(repo, db);
    expect(replayRes.replayedCount).toBe(6);
    expect(replayRes.snapshotsCreated).toBe(1);

    expect(() => journal.replayToDb(repo, db)).not.toThrow();

    // Verify SQLite projection
    const workspaceInDb = repo.getWorkspace('workspace_replay');
    expect(workspaceInDb?.title).toBe('Test Workspace Name');

    const opInDb = repo.getOperation('op_replay_1');
    expect(opInDb?.state).toBe('settled');
    expect(opInDb?.settlement).toEqual({ count: 10 });

    const snap = repo.getSnapshot('ch_1');
    expect(snap?.contentMarkdown).toContain('少年UserB');
    expect(snap?.contentSize).toBeGreaterThan(0);

    db.close();
  });

  it('should persist, reopen, and repair an unterminated JSONL tail', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inkpi-journal-'));
    const filePath = join(directory, 'session.jsonl');

    const journal1 = new AppendOnlySessionJournal({
      sessionId: 'durable_session',
      filePath,
      idGenerator: (() => {
        let next = 0;
        return () => `event_${++next}`;
      })(),
      clock: () => 1000
    });
    journal1.append('user_message', { text: 'persisted' });
    journal1.append('agent_turn', { text: 'response' });

    expect(readFileSync(filePath, 'utf8').split('\n').filter(Boolean)).toHaveLength(2);

    const journal2 = new AppendOnlySessionJournal({ sessionId: 'durable_session', filePath });
    expect(journal2.count()).toBe(2);
    expect(journal2.getEntries()[0].payload).toEqual({ text: 'persisted' });

    appendFileSync(filePath, '{"id":"interrupted"');
    const journal3 = new AppendOnlySessionJournal({ sessionId: 'durable_session', filePath });
    expect(journal3.count()).toBe(2);
    expect(readFileSync(filePath, 'utf8')).not.toContain('"interrupted"');

    journal3.append('custom', { value: 'after-reopen' }, 'event_3');
    expect(journal3.getEntry('event_3')?.seq).toBe(3);
    expect(journal3.getEntry('event_3')?.parentId).toBe('event_2');
    const journal4 = new AppendOnlySessionJournal({ sessionId: 'durable_session', filePath });
    expect(journal4.getEntry('event_3')?.payload).toEqual({ value: 'after-reopen' });
    expect(journal4.getEntry('event_3')?.seq).toBe(3);
  });
});
