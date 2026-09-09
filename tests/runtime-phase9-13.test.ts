import { ArtifactRuntime, DomainProposalLedger, ProposalConflictError } from '@inkpi/agent-core';
import type { AiTask, Artifact, DomainChangeSet } from '@inkpi/protocol';
import { InMemoryTransport, InkPiDaemon, InkRpcClient } from '@inkpi/server';
import { ArtifactConflictError, DomainProjectionStore, InkDb, SqliteArtifactStore } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';
import { calculateDomainChangeSetChecksum } from '../packages/protocol/src/domain-sync.js';

describe('Runtime Phase 9-13 integration contracts', () => {
  it('keeps proposal review separate from authoritative CAS commit and supports undo', async () => {
    let now = 100;
    const ledger = new DomainProposalLedger(() => now++);
    const proposal = ledger.create({
      id: 'proposal-1',
      taskId: 'task-1',
      baseRevision: 4,
      sourceHash: 'source-v1',
      target: { type: 'document', id: 'doc-1' },
      operation: 'update',
      patch: { text: 'new text' }
    });
    proposal.patch = { text: 'mutated outside ledger' };
    expect(ledger.get('proposal-1')?.patch).toEqual({ text: 'new text' });
    expect(ledger.accept('proposal-1').status).toBe('accepted');

    let authoritativeRevision = 4;
    const receipt = await ledger.commit(
      'proposal-1',
      authoritativeRevision,
      (patch, nextRevision) => {
        expect(patch).toEqual({ text: 'new text' });
        authoritativeRevision = nextRevision;
        return { inversePatch: { text: 'old text' } };
      },
      'source-v1'
    );
    expect(receipt.revision).toBe(5);
    expect(ledger.get('proposal-1')).toMatchObject({ status: 'committed', committedRevision: 5 });

    await ledger.undo('proposal-1', authoritativeRevision, (patch, nextRevision) => {
      expect(patch).toEqual({ text: 'old text' });
      authoritativeRevision = nextRevision;
    });
    expect(authoritativeRevision).toBe(6);
    expect(ledger.get('proposal-1')?.status).toBe('undone');

    const stale = ledger.create({
      id: 'proposal-stale',
      taskId: 'task-2',
      baseRevision: 6,
      target: { type: 'document', id: 'doc-1' },
      operation: 'update',
      patch: { text: 'stale' }
    });
    expect(stale.status).toBe('pending');
    ledger.accept(stale.id);
    await expect(ledger.commit(stale.id, 7, () => ({ inversePatch: {} }))).rejects.toBeInstanceOf(
      ProposalConflictError
    );
    expect(ledger.get(stale.id)?.status).toBe('stale');
    expect(ledger.rebase(stale.id, 7, (patch) => ({ ...(patch as object), rebased: true })).status).toBe('pending');
  });

  it('rejects a reused domain change-set id from another workspace', () => {
    const db = new InkDb();
    try {
      const projection = new DomainProjectionStore(db);
      const makeSet = (workspaceId: string): DomainChangeSet => {
        const unsigned = {
          id: 'shared-change-set-id',
          workspaceId,
          sourceDeviceId: 'desktop-1',
          baseRevision: 0,
          revision: 1,
          changes: [],
          createdAt: 1
        } satisfies Omit<DomainChangeSet, 'checksum'>;
        return { ...unsigned, checksum: calculateDomainChangeSetChecksum(unsigned) };
      };
      expect(projection.apply(makeSet('workspace-a')).accepted).toBe(true);
      expect(() => projection.apply(makeSet('workspace-b'))).toThrow('Domain change set id collision');
    } finally {
      db.close();
    }
  });

  it('persists semantic artifacts in SQLite and exposes them through daemon RPC', async () => {
    const db = new InkDb();
    const store = new SqliteArtifactStore(db);
    const runtime = new ArtifactRuntime(store, () => 10);
    const task: AiTask = {
      id: 'artifact-task',
      kind: 'test.distill',
      input: { documentId: 'doc-1' },
      outputContract: { format: 'structured', persistence: 'artifact', schemaId: 'runtime.summary' },
      metadata: { artifactType: 'creative.chapter-summary' }
    };
    const artifact = await runtime.persistTaskResult(task, {
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      output: { format: 'structured', data: { summary: 'stable', nested: { value: 1 } } },
      provenance: { executionRunId: 'run-1' }
    });
    expect(artifact).toMatchObject({
      id: 'artifact:artifact-task',
      type: 'creative.chapter-summary',
      content: { summary: 'stable', nested: { value: 1 } },
      provenance: { taskId: task.id, executionRunId: 'run-1' }
    });

    const returned = store.get(artifact!.id)!;
    (returned.content as { nested: { value: number } }).nested.value = 99;
    expect(store.get(artifact!.id)?.content).toEqual({ summary: 'stable', nested: { value: 1 } });
    expect(() => store.save({ ...artifact!, content: { summary: 'different' } } as Artifact)).toThrow(
      ArtifactConflictError
    );

    const daemon = new InkPiDaemon({ context: { artifactStore: store } });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    await expect(client.getArtifact(artifact!.id)).resolves.toMatchObject({ id: artifact!.id });
    await expect(client.listArtifacts({ type: 'creative.chapter-summary' })).resolves.toHaveLength(1);
    await client.close();
    await daemon.stop();
    db.close();
  });
});
