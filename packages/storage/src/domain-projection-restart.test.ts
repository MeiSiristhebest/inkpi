import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DomainChange, type DomainChangeSet, calculateDomainChangeSetChecksum } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { InkDb } from './db.js';
import { DomainProjectionStore } from './domain-projection.js';

function makeChangeSet(
  id: string,
  workspaceId: string,
  baseRevision: number,
  changes: DomainChange[],
  createdAt = baseRevision + 1
): DomainChangeSet {
  const unsigned: Omit<DomainChangeSet, 'checksum'> = {
    id,
    workspaceId,
    sourceDeviceId: 'desktop-restart-test',
    baseRevision,
    revision: baseRevision + 1,
    changes,
    createdAt
  };
  return { ...unsigned, checksum: calculateDomainChangeSetChecksum(unsigned) };
}

function change(
  id: string,
  aggregateType: string,
  aggregateId: string,
  payload: unknown,
  revision = 1,
  occurredAt = revision
): DomainChange {
  return { id, aggregateType, aggregateId, operation: 'upsert', payload, revision, occurredAt };
}

describe('persistent domain projection recovery', () => {
  it('persists story-state through restart and protects recovery from stale or corrupt snapshots', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'inkpi-domain-restart-')), 'state.sqlite');
    const first = makeChangeSet('set-1', 'workspace-1', 0, [
      change('story-state-1', 'story-state', 'state-1', {
        revision: 1,
        facts: [{ id: 'fact-1', value: 'stable' }],
        entities: [{ id: 'character-1', name: '主角' }],
        relations: [{ from: 'character-1', to: 'fact-1', kind: 'supports' }]
      })
    ]);
    const second = makeChangeSet('set-2', 'workspace-1', 1, [
      change(
        'story-state-2',
        'story-state',
        'state-1',
        {
          revision: 2,
          facts: [{ id: 'fact-1', value: 'resolved' }],
          entities: [{ id: 'character-1', name: '主角' }],
          relations: [{ from: 'character-1', to: 'fact-1', kind: 'resolves' }]
        },
        2,
        2
      )
    ]);

    const initialDb = new InkDb(dbPath);
    expect(new DomainProjectionStore(initialDb, () => 100).apply(first)).toMatchObject({
      accepted: true,
      revision: 1
    });
    initialDb.close();

    const restartedDb = new InkDb(dbPath);
    const restartedProjection = new DomainProjectionStore(restartedDb, () => 200);
    expect(restartedProjection.getCursor('workspace-1')).toMatchObject({ revision: 1 });
    expect(restartedProjection.getGenericProjection('workspace-1', 'story-state', 'state-1')).toMatchObject({
      revision: 1,
      payload: {
        facts: [{ id: 'fact-1', value: 'stable' }],
        entities: [{ id: 'character-1', name: '主角' }]
      }
    });

    expect(restartedProjection.apply(second)).toMatchObject({ accepted: true, revision: 2 });
    const stale = makeChangeSet('set-4', 'workspace-1', 3, [
      change('story-state-4', 'story-state', 'state-1', { revision: 4 }, 4, 4)
    ]);
    expect(restartedProjection.apply(stale)).toMatchObject({
      accepted: false,
      reason: 'revision-conflict',
      revision: 2
    });

    const snapshot = restartedProjection.createSnapshot('workspace-1');
    expect(() =>
      restartedProjection.restoreSnapshot({
        ...snapshot,
        changeSets: snapshot.changeSets.map((changeSet, index) =>
          index === 0 ? { ...changeSet, checksum: 'corrupt' } : changeSet
        )
      })
    ).toThrow('checksum mismatch');
    restartedDb.close();

    const finalDb = new InkDb(dbPath);
    const finalProjection = new DomainProjectionStore(finalDb, () => 300);
    expect(finalProjection.getCursor('workspace-1')).toMatchObject({ revision: 2 });
    expect(finalProjection.getGenericProjection('workspace-1', 'story-state', 'state-1')).toMatchObject({
      revision: 2,
      payload: {
        facts: [{ id: 'fact-1', value: 'resolved' }],
        relations: [{ from: 'character-1', to: 'fact-1', kind: 'resolves' }]
      }
    });
    finalDb.close();
  });
});
