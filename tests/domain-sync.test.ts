import { calculateDomainChangeSetChecksum, type DomainChange, type DomainChangeSet } from '@inkpi/protocol';
import { InkPiDaemon, InkRpcClient, InMemoryTransport } from '@inkpi/server';
import { DomainProjectionStore, InkDb } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

describe('desktop-authoritative domain projection sync', () => {
  it('accepts an ordered change set in SQLite and exposes the derived RPC projection', async () => {
    const db = new InkDb();
    const projection = new DomainProjectionStore(db, () => 10);
    const daemon = new InkPiDaemon({ context: { domainProjection: projection } });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    const unsignedChangeSet: Omit<DomainChangeSet, 'checksum'> = {
      id: 'set-1',
      workspaceId: 'workspace-1',
      sourceDeviceId: 'desktop-1',
      baseRevision: 0,
      revision: 1,
      createdAt: 1,
      changes: [
        {
          id: 'change-1',
          aggregateType: 'document',
          aggregateId: 'chapter-1',
          operation: 'upsert',
          revision: 1,
          payload: { text: '正文' },
          occurredAt: 1,
        } satisfies DomainChange,
      ],
    };
    const changeSet: DomainChangeSet = {
      ...unsignedChangeSet,
      checksum: calculateDomainChangeSetChecksum(unsignedChangeSet),
    };

    expect(await client.pushDomainChangeSet(changeSet)).toMatchObject({ accepted: true, revision: 1 });
    expect(await client.pushDomainChangeSet(changeSet)).toMatchObject({ accepted: true, duplicate: true });
    expect(await client.pullDomainChangeSets('workspace-1')).toEqual([changeSet]);
    const staleUnsigned = { ...changeSet, id: 'set-stale', baseRevision: 0, revision: 1 };
    const { checksum: _staleChecksum, ...staleWithoutChecksum } = staleUnsigned;
    expect(
      await client.pushDomainChangeSet({
        ...staleWithoutChecksum,
        checksum: calculateDomainChangeSetChecksum(staleWithoutChecksum),
      }),
    ).toMatchObject({ accepted: false, reason: 'revision-conflict' });

    const snapshot = await client.snapshotDomain('workspace-1');
    expect(snapshot.revision).toBe(1);
    expect(await client.restoreDomainSnapshot(snapshot)).toMatchObject({ workspaceId: 'workspace-1', revision: 1 });

    await client.close();
    await daemon.stop();
    db.close();
  });

  it('rejects out-of-order revisions and then accepts them in order', async () => {
    const db = new InkDb();
    const projection = new DomainProjectionStore(db, () => 10);
    const daemon = new InkPiDaemon({ context: { domainProjection: projection } });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    const changeSet = (revision: number, baseRevision: number): DomainChangeSet => {
      const unsigned = {
        id: `ordered-${revision}`,
        workspaceId: 'workspace-order',
        sourceDeviceId: 'desktop-1',
        baseRevision,
        revision,
        createdAt: revision,
        changes: [],
      } satisfies Omit<DomainChangeSet, 'checksum'>;
      return { ...unsigned, checksum: calculateDomainChangeSetChecksum(unsigned) };
    };

    expect(await client.pushDomainChangeSet(changeSet(2, 1))).toMatchObject({
      accepted: false,
      duplicate: false,
      revision: 0,
      reason: 'revision-conflict',
    });
    expect(await client.pushDomainChangeSet(changeSet(1, 0))).toMatchObject({ accepted: true, revision: 1 });
    expect(await client.pushDomainChangeSet(changeSet(2, 1))).toMatchObject({ accepted: true, revision: 2 });
    expect(await client.pullDomainChangeSets('workspace-order')).toHaveLength(2);

    await client.close();
    await daemon.stop();
    db.close();
  });

  it('rejects a change set with an incorrect checksum', async () => {
    const db = new InkDb();
    const projection = new DomainProjectionStore(db);
    const daemon = new InkPiDaemon({ context: { domainProjection: projection } });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    const changeSet: DomainChangeSet = {
      id: 'bad-checksum',
      workspaceId: 'workspace-checksum',
      sourceDeviceId: 'desktop-1',
      baseRevision: 0,
      revision: 1,
      createdAt: 1,
      changes: [],
      checksum: '00000000',
    };

    await expect(client.pushDomainChangeSet(changeSet)).rejects.toThrow('checksum mismatch');

    await client.close();
    await daemon.stop();
    db.close();
  });
});
