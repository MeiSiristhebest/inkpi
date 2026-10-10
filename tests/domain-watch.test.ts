import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InkRpcClient as PublicClient } from '@inkpi/client';
import {
  type DomainChangeSet,
  type DomainSyncPageParams,
  calculateDomainChangeSetChecksum,
  watchDomainChanges
} from '@inkpi/protocol';
import { InkPiDaemon, InkRpcClient as ServerClient } from '@inkpi/server';
import { DomainProjectionStore, InkDb } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function set(workspaceId: string, revision: number, text = `value-${revision}`, deletion = false): DomainChangeSet {
  const unsigned = {
    id: `${workspaceId}-${revision}-${text.length}`,
    workspaceId,
    sourceDeviceId: 'watch-test',
    baseRevision: revision - 1,
    revision,
    createdAt: revision,
    changes: [
      {
        id: `change-${revision}`,
        aggregateType: 'custom',
        aggregateId: 'record',
        operation: deletion ? ('delete' as const) : ('upsert' as const),
        revision,
        occurredAt: revision,
        payload: deletion ? undefined : { text }
      }
    ]
  };
  return { ...unsigned, checksum: calculateDomainChangeSetChecksum(unsigned) };
}
function reader(store: DomainProjectionStore) {
  return {
    snapshotDomain: async (id: string) => store.createSnapshot(id),
    pullDomainChangePage: async (params: DomainSyncPageParams) => store.readPage(params)
  };
}

describe('domain snapshot and revision observation', () => {
  it('delivers a snapshot barrier before requesting changes committed during snapshot delivery', async () => {
    const db = new InkDb();
    const store = new DomainProjectionStore(db);
    store.apply(set('book', 1));
    const captured = gate();
    const send = gate();
    const port = reader(store);
    port.snapshotDomain = async (id) => {
      const snapshot = store.createSnapshot(id);
      captured.release();
      await send.promise;
      return snapshot;
    };
    const pull = vi.spyOn(port, 'pullDomainChangePage');
    const watch = watchDomainChanges(port, 'book');
    try {
      const initial = watch.next();
      await captured.promise;
      store.apply(set('book', 2));
      expect(pull).not.toHaveBeenCalled();
      send.release();
      expect((await initial).value).toMatchObject({ type: 'snapshot', snapshot: { revision: 1 } });
      expect(pull).not.toHaveBeenCalled();
      expect((await watch.next()).value).toMatchObject({ type: 'changes', revision: 2 });
    } finally {
      send.release();
      await watch.return!();
      db.close();
    }
  });

  it('uses consumer demand as backpressure and retains the complete audit log while paging', async () => {
    const db = new InkDb();
    const store = new DomainProjectionStore(db);
    const port = reader(store);
    const pull = vi.spyOn(port, 'pullDomainChangePage');
    const watch = watchDomainChanges(port, 'book', { pageSize: 2 });
    try {
      expect((await watch.next()).value).toMatchObject({ type: 'snapshot', snapshot: { revision: 0 } });
      for (let revision = 1; revision <= 7; revision++) store.apply(set('book', revision));
      expect(pull).not.toHaveBeenCalled();
      const seen: number[] = [];
      for (let page = 0; page < 4; page++) {
        const event = (await watch.next()).value;
        expect(event.type).toBe('changes');
        if (event.type === 'changes') {
          expect(event.changeSets.length).toBeLessThanOrEqual(2);
          seen.push(...event.changeSets.map((change: DomainChangeSet) => change.revision));
          event.changeSets[0].changes.length = 0;
        }
      }
      expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(pull).toHaveBeenCalledTimes(4);
      expect(store.list('book').map((change) => change.changes.length)).toEqual([1, 1, 1, 1, 1, 1, 1]);
    } finally {
      await watch.return!();
      db.close();
    }
  });

  it('resets after earlier history is replaced even when the head record and revision are unchanged', async () => {
    const db = new InkDb();
    const store = new DomainProjectionStore(db);
    const first = set('book', 1);
    const head = set('book', 2);
    store.apply(first);
    store.apply(head);
    const watch = watchDomainChanges(reader(store), 'book');
    try {
      const initial = (await watch.next()).value;
      const snapshot = store.createSnapshot('book');
      const replacement = set('book', 1, 'replaced earlier history');
      store.restoreSnapshot({ ...snapshot, changeSets: [replacement, head] });
      const reset = (await watch.next()).value;
      expect(reset).toMatchObject({ type: 'reset', snapshot: { revision: 2, changeSets: [replacement, head] } });
      expect((reset as any).snapshot.epoch).not.toBe((initial as any).snapshot.epoch);
      store.purgeWorkspace('book');
      expect((await watch.next()).value).toMatchObject({ type: 'reset', snapshot: { revision: 0, changeSets: [] } });
    } finally {
      await watch.return!();
      db.close();
    }
  });

  it('persists epoch across restart and migrates older cursor rows once', () => {
    const directory = mkdtempSync(join(tmpdir(), 'inkpi-domain-epoch-'));
    const filename = join(directory, 'state.sqlite');
    let db = new InkDb(filename);
    try {
      new DomainProjectionStore(db).apply(set('book', 1));
      db.exec('ALTER TABLE domain_projection_cursors DROP COLUMN epoch');
      db.exec('PRAGMA user_version = 2');
      db.close();
      db = new InkDb(filename);
      const store = new DomainProjectionStore(db);
      const initial = store.createSnapshot('book');
      expect(initial.epoch).toMatch(/^[a-f0-9]{32}$/);
      db.close();
      db = new InkDb(filename);
      const restarted = new DomainProjectionStore(db);
      expect(restarted.createSnapshot('book').epoch).toBe(initial.epoch);
      restarted.apply(set('book', 2));
      expect(
        restarted.readPage({ workspaceId: 'book', afterRevision: 1, epoch: initial.epoch!, limit: 1 })
      ).toMatchObject({
        reset: false,
        revision: 2,
        changeSets: [set('book', 2)]
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('checks byte limits before loading large records and preserves every accepted log entry', () => {
    const db = new InkDb();
    const store = new DomainProjectionStore(db);
    try {
      for (let revision = 1; revision <= 3; revision++) store.apply(set('book', revision, 'x'.repeat(600_000)));
      const snapshot = store.createSnapshot('book');
      const read = vi.spyOn(store, 'list');
      const page = store.readPage({ workspaceId: 'book', afterRevision: 0, epoch: snapshot.epoch!, limit: 3 });
      expect(page.changeSets).toHaveLength(1);
      expect(read).toHaveBeenLastCalledWith('book', 0, 1);
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThan(1024 * 1024);
      store.apply(set('book', 4, 'x'.repeat(1_100_000)));
      read.mockClear();
      expect(() => store.readPage({ workspaceId: 'book', afterRevision: 3, epoch: snapshot.epoch! })).toThrow(/1 MiB/);
      expect(read).not.toHaveBeenCalled();
      expect(store.getCursor('book').revision).toBe(4);
    } finally {
      db.close();
    }
  });

  it.each(['gap', 'duplicate', 'foreign', 'epoch'])('rejects a %s page before publishing any update', async (fault) => {
    const db = new InkDb();
    const store = new DomainProjectionStore(db);
    store.apply(set('book', 1));
    const port = reader(store);
    port.pullDomainChangePage = async (params) => {
      const page = store.readPage(params);
      if (fault === 'epoch') page.epoch = 'foreign-epoch';
      else
        page.changeSets = [
          set(fault === 'foreign' ? 'foreign' : 'book', fault === 'gap' ? 3 : fault === 'duplicate' ? 1 : 2)
        ];
      return page;
    };
    const watch = watchDomainChanges(port, 'book');
    try {
      await watch.next();
      store.apply(set('book', 2));
      await expect(watch.next()).rejects.toThrow(fault === 'epoch' ? /epoch/ : /contiguous/);
    } finally {
      await watch.return!();
      db.close();
    }
  });

  it('closes a waiting observation without leaving a long polling timer or changing source state', async () => {
    const db = new InkDb();
    const store = new DomainProjectionStore(db);
    const port = reader(store);
    const emptyRead = gate();
    port.pullDomainChangePage = async (params) => {
      emptyRead.release();
      return store.readPage(params);
    };
    const watch = watchDomainChanges(port, 'book', { pollIntervalMs: 60_000 });
    try {
      await watch.next();
      const pending = expect(watch.next()).rejects.toThrow(/closed/);
      await emptyRead.promise;
      await watch.return!();
      await pending;
      expect(store.getCursor('book').revision).toBe(0);
    } finally {
      await watch.return!();
      db.close();
    }
  });

  it.each([PublicClient, ServerClient])(
    'observes actual TCP commits and legacy delete checksums with %s',
    async (Client) => {
      const db = new InkDb();
      const store = new DomainProjectionStore(db);
      const daemon = new InkPiDaemon({ context: { domainProjection: store } });
      await daemon.start(0, '127.0.0.1');
      const client = await Client.connectTcp(daemon.getPort(), '127.0.0.1');
      const watch = client.watchDomain('book');
      try {
        expect((await watch.next()).value).toMatchObject({ type: 'snapshot', snapshot: { revision: 0 } });
        const first = set('book', 1);
        const deletion = set('book', 2, 'delete', true);
        await client.pushDomainChangeSet(first);
        await client.pushDomainChangeSet(deletion);
        expect((await watch.next()).value).toMatchObject({
          type: 'changes',
          revision: 2,
          changeSets: [first, deletion]
        });
        await client.restoreDomainSnapshot({ workspaceId: 'book', revision: 1, changeSets: [first], createdAt: 1 });
        expect((await watch.next()).value).toMatchObject({ type: 'reset', snapshot: { revision: 1 } });
      } finally {
        await watch.return!();
        await client.close();
        await daemon.stop();
        db.close();
      }
    }
  );
});
