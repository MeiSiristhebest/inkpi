import {
  type DomainChangeSet,
  type DomainProjectionSnapshot,
  type DomainSyncPage,
  type DomainSyncPageParams,
  restoreDomainChangeSetWireValue
} from './domain-sync.js';
import { awaitWithAbort } from './task-wait.js';

export interface DomainWatchReader {
  snapshotDomain(workspaceId: string): Promise<DomainProjectionSnapshot>;
  pullDomainChangePage(params: DomainSyncPageParams): Promise<DomainSyncPage>;
}
export interface DomainWatchOptions {
  signal?: AbortSignal;
  pageSize?: number;
  pollIntervalMs?: number;
}
export type DomainWatchEvent =
  | { type: 'snapshot' | 'reset'; snapshot: DomainProjectionSnapshot }
  | { type: 'changes'; workspaceId: string; revision: number; changeSets: DomainChangeSet[] };

/** Pull-based backpressure: no update is read until the consumer requests it. */
export function watchDomainChanges(
  reader: DomainWatchReader,
  workspaceId: string,
  options: DomainWatchOptions = {}
): AsyncIterableIterator<DomainWatchEvent> {
  const pageSize = options.pageSize ?? 100;
  const interval = options.pollIntervalMs ?? 250;
  if (
    !workspaceId.trim() ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 1000 ||
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    interval > 60_000
  )
    throw new Error('Invalid domain watch options');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const iterator = iterate();
  return {
    next: () => iterator.next(),
    return: async () => {
      controller.abort(new DOMException('Domain watch closed', 'AbortError'));
      try {
        await iterator.return();
      } catch (error) {
        if (!signal.aborted) throw error;
      }
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    }
  };

  async function* iterate(): AsyncGenerator<DomainWatchEvent, void, unknown> {
    let revision = 0;
    let epoch = '';
    let snapshotType: 'snapshot' | 'reset' = 'snapshot';
    let needsSnapshot = true;
    while (true) {
      signal.throwIfAborted();
      if (needsSnapshot) {
        const input = await awaitWithAbort(reader.snapshotDomain(workspaceId), signal);
        if (
          input.workspaceId !== workspaceId ||
          !Number.isSafeInteger(input.revision) ||
          input.revision < 0 ||
          typeof input.epoch !== 'string' ||
          !Array.isArray(input.changeSets)
        )
          throw new Error('Invalid domain watch snapshot');
        const snapshot = { ...structuredClone(input), changeSets: validateChanges(input.changeSets, workspaceId, 0) };
        if ((snapshot.changeSets.at(-1)?.revision ?? 0) !== snapshot.revision)
          throw new Error('Domain snapshot revision does not match its log');
        revision = snapshot.revision;
        epoch = input.epoch;
        needsSnapshot = false;
        yield { type: snapshotType, snapshot };
        continue;
      }
      const page = await awaitWithAbort(
        reader.pullDomainChangePage({ workspaceId, afterRevision: revision, epoch, limit: pageSize }),
        signal
      );
      if (
        page.workspaceId !== workspaceId ||
        page.afterRevision !== revision ||
        !Number.isSafeInteger(page.revision) ||
        page.revision < 0 ||
        typeof page.epoch !== 'string' ||
        typeof page.reset !== 'boolean' ||
        !Array.isArray(page.changeSets) ||
        page.changeSets.length > pageSize
      )
        throw new Error('Invalid domain watch page');
      if (page.reset) {
        if (page.changeSets.length) throw new Error('Domain reset must not contain ordinary changes');
        needsSnapshot = true;
        snapshotType = 'reset';
        continue;
      }
      if (page.epoch !== epoch && !(revision === 0 && epoch === ''))
        throw new Error('Domain page changed epoch without reset');
      const changes = validateChanges(page.changeSets, workspaceId, revision);
      const nextRevision = changes.at(-1)?.revision ?? revision;
      if (nextRevision > page.revision || (!changes.length && revision !== page.revision))
        throw new Error('Domain page revision does not match its log');
      epoch = page.epoch;
      if (changes.length) {
        revision = nextRevision;
        yield { type: 'changes', workspaceId, revision, changeSets: changes };
      } else await pause(signal, interval);
    }
  }
}

function validateChanges(changes: DomainChangeSet[], workspaceId: string, afterRevision: number): DomainChangeSet[] {
  let expected = afterRevision + 1;
  return changes.map((input) => {
    const change = restoreDomainChangeSetWireValue(input);
    if (change.workspaceId !== workspaceId || change.baseRevision !== expected - 1 || change.revision !== expected)
      throw new Error('Domain changes are not contiguous');
    expected++;
    return change;
  });
}

function pause(signal: AbortSignal, milliseconds: number): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}
