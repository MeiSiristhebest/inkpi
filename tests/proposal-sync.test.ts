import { InkRpcClient, MemoryTransport } from '@inkpi/client';
import {
  type ProposalProjectionState,
  calculateProposalProjectionSnapshotHash,
  calculateProposalProjectionStateHash
} from '@inkpi/protocol';
import { InkPiDaemon } from '@inkpi/server';
import { InkDb, ProposalProjectionStore } from '@inkpi/storage';
import { afterEach, describe, expect, it } from 'vitest';

const openDbs: InkDb[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function makeState(overrides: Partial<ProposalProjectionState> = {}): ProposalProjectionState {
  return {
    id: 'proposal-1',
    taskId: 'task-1',
    baseRevision: 4,
    sourceHash: 'document-hash-4',
    target: { type: 'document', id: 'chapter-1' },
    operation: 'update',
    patch: [{ documentId: 'chapter-1', from: 0, to: 1, text: '改' }],
    status: 'pending',
    createdAt: 10,
    updatedAt: 10,
    ...overrides
  };
}

function connect(daemon: InkPiDaemon): InkRpcClient {
  const [clientTransport, serverTransport] = MemoryTransport.createPair();
  daemon.attachTransport(serverTransport);
  return new InkRpcClient(clientTransport);
}

describe('proposal projection protocol', () => {
  it('produces the same state hash after JSON RPC encoding and ignores object key order', () => {
    const state = makeState();
    const reordered = {
      ...state,
      target: { id: 'chapter-1', type: 'document' },
      patch: [{ text: '改', to: 1, from: 0, documentId: 'chapter-1' }]
    };

    expect(calculateProposalProjectionStateHash(state)).toBe(calculateProposalProjectionStateHash(reordered));
    expect(JSON.parse(JSON.stringify({ proposal: state }))).toEqual({ proposal: state });
    expect(
      calculateProposalProjectionSnapshotHash({ workspaceId: 'workspace-1', revision: 1, proposals: [state] })
    ).toBe(
      calculateProposalProjectionSnapshotHash({
        workspaceId: 'workspace-1',
        revision: 1,
        proposals: [reordered]
      })
    );
  });

  it('round-trips proposal state over JSON RPC and enforces hash plus revision CAS', async () => {
    const db = new InkDb();
    openDbs.push(db);
    const daemon = new InkPiDaemon({
      context: { proposalProjection: new ProposalProjectionStore(db, () => 100) }
    });
    const client = connect(daemon);
    const pending = makeState();

    await expect(client.pushProposalState('workspace-1', 0, pending)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      revision: 1,
      proposalId: 'proposal-1',
      stateHash: calculateProposalProjectionStateHash(pending)
    });
    await expect(client.pushProposalState('workspace-1', 0, pending)).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      revision: 1
    });

    const tampered = await client.request<{
      accepted: boolean;
      reason?: string;
      revision: number;
    }>('proposal.sync.push', {
      workspaceId: 'workspace-1',
      expectedRevision: 1,
      proposal: { ...pending, status: 'accepted', updatedAt: 11 },
      stateHash: '00000000'
    });
    expect(tampered).toMatchObject({ accepted: false, reason: 'hash-mismatch', revision: 1 });

    const accepted = makeState({ status: 'accepted', updatedAt: 11 });
    await expect(client.pushProposalState('workspace-1', 0, accepted)).resolves.toMatchObject({
      accepted: false,
      duplicate: false,
      reason: 'revision-conflict',
      revision: 1
    });
    await expect(client.pushProposalState('workspace-1', 1, accepted)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      revision: 2
    });

    await client.close();
    await daemon.stop();
  });

  it('rehydrates the derived proposal projection after daemon restart', async () => {
    const db = new InkDb();
    openDbs.push(db);
    const firstDaemon = new InkPiDaemon({
      context: { proposalProjection: new ProposalProjectionStore(db, () => 100) }
    });
    const firstClient = connect(firstDaemon);
    const committed = makeState({
      status: 'committed',
      committedRevision: 5,
      inversePatch: [{ documentId: 'chapter-1', from: 0, to: 1, text: '原' }],
      updatedAt: 12
    });
    await firstClient.pushProposalState('workspace-restart', 0, committed);
    await firstClient.close();
    await firstDaemon.stop();

    const restartedDaemon = new InkPiDaemon({
      context: { proposalProjection: new ProposalProjectionStore(db, () => 200) }
    });
    const restartedClient = connect(restartedDaemon);
    await expect(restartedClient.snapshotProposals('workspace-restart')).resolves.toMatchObject({
      workspaceId: 'workspace-restart',
      revision: 1,
      proposals: [committed],
      hash: calculateProposalProjectionSnapshotHash({
        workspaceId: 'workspace-restart',
        revision: 1,
        proposals: [committed]
      })
    });

    await restartedClient.close();
    await restartedDaemon.stop();
  });
});
