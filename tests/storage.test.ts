import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InkDb, InkRepository, CompactionEngine } from '@meisiristhebest/storage';
import type { Workspace, Folder, Document } from '@meisiristhebest/protocol';

describe('@meisiristhebest/storage', () => {
  let db: InkDb;
  let repo: InkRepository;
  let compaction: CompactionEngine;

  beforeEach(() => {
    db = new InkDb(':memory:');
    repo = new InkRepository(db);
    compaction = new CompactionEngine(db, repo);
  });

  afterEach(() => {
    db.close();
  });

  it('should create and retrieve Workspaces, Folders, and Documents', () => {
    const workspace: Workspace = {
      id: 'workspace_01',
      title: 'Test Workspace Name',
      owner: '墨派大师',
      category: 'standard',
      targetSize: 1500000,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    repo.createWorkspace({
      ...workspace,
      metadata: { theme: 'cyberpunk', customFlag: true }
    });

    const fetchedWorkspace = repo.getWorkspace('workspace_01');
    expect(fetchedWorkspace).toBeDefined();
    expect(fetchedWorkspace?.title).toBe('Test Workspace Name');
    expect(fetchedWorkspace?.metadata?.theme).toBe('cyberpunk');

    // Non-existent workspace
    expect(repo.getWorkspace('non_existent')).toBeUndefined();

    // Raw insert with malformed metadata to test JSON catch block
    db.prepare('INSERT INTO workspaces (id, title, owner, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'ws_malformed',
      'Malformed WS',
      'user',
      'invalid-json{',
      Date.now(),
      Date.now()
    );
    const malformedWs = repo.getWorkspace('ws_malformed');
    expect(malformedWs?.metadata).toBeUndefined();

    const folder: Folder = {
      id: 'vol_01',
      workspaceId: 'workspace_01',
      title: 'Folder 1 Test',
      orderIndex: 1,
      summary: '主角初入World',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    repo.createFolder(folder);

    const folders = repo.getFolders('workspace_01');
    expect(folders.length).toBe(1);
    expect(folders[0].title).toBe('Folder 1 Test');

    const document: Document = {
      id: 'ch_01',
      folderId: 'vol_01',
      workspaceId: 'workspace_01',
      title: 'Document 1 Intro',
      orderIndex: 1,
      synopsis: '开篇',
      contentSize: 3200,
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    repo.createDocument(document);

    const documents = repo.getDocuments('vol_01');
    expect(documents.length).toBe(1);
    expect(documents[0].title).toBe('Document 1 Intro');
  });

  it('should rollback transaction on error', () => {
    expect(() => {
      db.transaction(() => {
        repo.createWorkspace({
          id: 'temp_workspace',
          title: 'Temp Workspace',
          owner: 'TestUser',
          category: 'test',
          targetSize: 1000,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
        throw new Error('Transaction aborted');
      });
    }).toThrow('Transaction aborted');

    const workspace = repo.getWorkspace('temp_workspace');
    expect(workspace).toBeUndefined();
  });

  it('should perform LSM incremental delta append, snapshot compaction, and crash recovery', () => {
    // 1. Create base workspace & document
    const now = Date.now();
    repo.createWorkspace({
      id: 'b1',
      title: 'workspace',
      owner: 'author',
      category: 'g',
      targetSize: 100,
      createdAt: now,
      updatedAt: now
    });
    repo.createFolder({
      id: 'v1',
      workspaceId: 'b1',
      title: 'folder',
      orderIndex: 1,
      createdAt: now,
      updatedAt: now
    });
    repo.createDocument({
      id: 'ch_comp',
      folderId: 'v1',
      workspaceId: 'b1',
      title: 'document',
      orderIndex: 1,
      contentSize: 0,
      status: 'draft',
      createdAt: now,
      updatedAt: now
    });

    // 2. Append 10 keystroke deltas
    for (let i = 0; i < 10; i++) {
      const deltaTs = now - (10 - i) * 100;
      repo.appendDelta({
        documentId: 'ch_comp',
        stepJson: JSON.stringify({ type: 'insert', text: `text${i}`, from: i * 3 }),
        clientTimestamp: deltaTs,
        createdAt: deltaTs
      });
    }

    let deltas = repo.getDeltas('ch_comp');
    expect(deltas.length).toBe(10);

    // 3. Compact into baseline snapshot
    const compacted = compaction.saveSnapshotAndCompact(
      'ch_comp',
      1,
      '{"type":"doc","content":[]}',
      'This is the merged text snapshot.',
      11
    );

    expect(compacted.deletedDeltas).toBe(10);

    // Assert deltas are cleaned up from database!
    deltas = repo.getDeltas('ch_comp');
    expect(deltas.length).toBe(0);

    // 4. Simulate typing 2 more uncompacted deltas after snapshot
    const postSnapshotTime = Date.now() + 5000;
    repo.appendDelta({
      documentId: 'ch_comp',
      stepJson: JSON.stringify({ type: 'insert', text: '[New text]' }),
      clientTimestamp: postSnapshotTime,
      createdAt: postSnapshotTime
    });

    // 5. Simulate sudden crash and execute recovery
    const recovery = compaction.recoverDocument('ch_comp');
    expect(recovery.replayedDeltasCount).toBe(1);
    expect(recovery.contentMarkdown).toBe('This is the merged text snapshot.[New text]');
    expect(recovery.contentSize).toBeGreaterThan(5);
    expect(recovery.recoveryErrors).toEqual([]);

    // 6. Test out-of-bounds delete delta in non-strict mode
    repo.appendDelta({
      documentId: 'ch_comp',
      stepJson: JSON.stringify({ type: 'delete', from: 0, to: 999999 }),
      clientTimestamp: Date.now() + 6000,
      createdAt: Date.now() + 6000
    });
    const nonStrictRecovery = compaction.recoverDocument('ch_comp', { strict: false });
    expect(nonStrictRecovery.recoveryErrors.length).toBe(1);
    expect(nonStrictRecovery.recoveryErrors[0].message).toContain('delete range');
  });

  it('should save and query Operations and SessionEntries projection records', () => {
    // 1. Operations test
    repo.saveOperation({
      id: 'op_test_1',
      sessionId: 'sess_storage_test',
      type: 'tool_call',
      state: 'running',
      intent: { tool: 'search', q: 'antigravity' },
      createdAt: 1000,
      updatedAt: 1000
    });

    const op = repo.getOperation('op_test_1');
    expect(op).toBeDefined();
    expect(op?.state).toBe('running');
    expect(op?.intent).toEqual({ tool: 'search', q: 'antigravity' });

    // Update operation state
    repo.saveOperation({
      id: 'op_test_1',
      sessionId: 'sess_storage_test',
      type: 'tool_call',
      state: 'settled',
      intent: { tool: 'search', q: 'antigravity' },
      settlement: { count: 42 },
      createdAt: 1000,
      updatedAt: 1050
    });

    const settledOp = repo.getOperation('op_test_1');
    expect(settledOp?.state).toBe('settled');
    expect(settledOp?.settlement).toEqual({ count: 42 });

    const allOps = repo.getOperations('sess_storage_test');
    expect(allOps.length).toBe(1);

    expect(repo.getOperation('non_existent_op')).toBeUndefined();

    // 2. SessionEntries test
    repo.saveSessionEntry({
      id: 'entry_p1',
      sessionId: 'sess_storage_test',
      seq: 1,
      parentId: null,
      laneId: 'main',
      type: 'user_message',
      timestamp: 2000,
      payload: { text: 'Hello' }
    });

    repo.saveSessionEntry({
      id: 'entry_p2',
      sessionId: 'sess_storage_test',
      seq: 2,
      parentId: 'entry_p1',
      type: 'agent_turn',
      timestamp: 2020,
      payload: { text: 'World' }
    });

    const entries = repo.getSessionEntries('sess_storage_test');
    expect(entries.length).toBe(2);
    expect(entries[0].seq).toBe(1);
    expect(entries[1].parentId).toBe('entry_p1');
    expect(entries[1].payload).toEqual({ text: 'World' });
  });
});
