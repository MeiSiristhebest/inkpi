import { SessionCommitError, type SessionEntry, assertJsonValue } from '@inkpi/protocol';
import type { SessionEntryPage, SessionEntryPageOptions } from './types.js';

export function validateStorageId(id: string): void {
  if (typeof id !== 'string' || !id.trim() || /[\\/:*?"<>|\x00-\x1f]/.test(id) || id === '.' || id === '..') {
    throw new Error('Storage IDs must be nonempty path components.');
  }
}

export function prepareEntryBatch(
  sessionId: string,
  current: readonly SessionEntry[],
  entries: readonly SessionEntry[]
): SessionEntry[] {
  try {
    validateStorageId(sessionId);
    const ids = new Set(current.map((entry) => entry.id));
    let lastSeq = current.at(-1)?.seq ?? 0;
    const prepared: SessionEntry[] = [];
    for (const entry of entries) {
      assertJsonValue(entry as unknown, 'session entry');
      if (entry.sessionId !== sessionId) throw new Error('Entry sessionId does not match its target.');
      if (typeof entry.id !== 'string' || !entry.id.trim() || ids.has(entry.id)) {
        throw new Error(`Duplicate or invalid session entry ID '${entry.id}'.`);
      }
      if (!Number.isSafeInteger(entry.seq) || entry.seq <= lastSeq) {
        throw new Error('Session sequences must be positive and strictly increasing.');
      }
      if (entry.parentId !== null && (typeof entry.parentId !== 'string' || !ids.has(entry.parentId))) {
        throw new Error(`Session parent '${entry.parentId}' is missing or follows its child.`);
      }
      if (!Number.isFinite(entry.timestamp) || typeof entry.type !== 'string' || !entry.type) {
        throw new Error('Invalid session entry type or timestamp.');
      }
      if (entry.version !== undefined && entry.version !== 1) throw new Error('Unsupported session entry version.');
      prepared.push(structuredClone({ ...entry, version: entry.version ?? 1 }));
      ids.add(entry.id);
      lastSeq = entry.seq;
    }
    return prepared;
  } catch (cause) {
    throw new SessionCommitError(cause instanceof Error ? cause.message : String(cause), 'rejected', { cause });
  }
}

export function pageEntries(
  sessionId: string,
  entries: readonly SessionEntry[],
  options: SessionEntryPageOptions = {}
): SessionEntryPage {
  validateStorageId(sessionId);
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Page limit must be 1 through 1000.');
  const cursor = options.cursor;
  const direction = options.direction ?? cursor?.direction ?? 'forward';
  if (direction !== 'forward' && direction !== 'backward') throw new Error('Invalid page direction.');
  const upperSeq = cursor?.upperSeq ?? entries.at(-1)?.seq ?? 0;
  if (cursor) {
    if (
      cursor.version !== 1 ||
      cursor.sessionId !== sessionId ||
      cursor.direction !== direction ||
      !Number.isSafeInteger(upperSeq) ||
      upperSeq < cursor.lastSeq ||
      !entries.some((entry) => entry.seq === upperSeq) ||
      !entries.some((entry) => entry.seq === cursor.lastSeq && entry.id === cursor.lastId)
    )
      throw new Error('Invalid session page cursor.');
  }
  const eligible = entries.filter(
    (entry) =>
      entry.seq <= upperSeq &&
      (!cursor || (direction === 'forward' ? entry.seq > cursor.lastSeq : entry.seq < cursor.lastSeq))
  );
  if (direction === 'backward') eligible.reverse();
  const page = eligible.slice(0, limit);
  const last = page.at(-1);
  return {
    entries: structuredClone(page),
    nextCursor:
      eligible.length > limit && last
        ? { version: 1, sessionId, direction, upperSeq, lastSeq: last.seq, lastId: last.id }
        : null
  };
}

export function forkEntries(
  sourceSessionId: string,
  targetSessionId: string,
  entries: readonly SessionEntry[],
  target: readonly SessionEntry[],
  headId?: string | null
): SessionEntry[] {
  validateStorageId(sourceSessionId);
  validateStorageId(targetSessionId);
  if (sourceSessionId === targetSessionId || target.length)
    throw new Error('Fork target must be a different empty session.');
  let selected = [...entries];
  if (headId !== undefined) {
    selected = [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const seen = new Set<string>();
    let id = headId;
    while (id !== null) {
      const entry = byId.get(id);
      if (!entry || seen.has(id)) throw new Error('Invalid fork head or cyclic session history.');
      seen.add(id);
      selected.push(entry);
      id = entry.parentId;
    }
    selected.reverse();
  }
  return selected.map((entry) => structuredClone({ ...entry, sessionId: targetSessionId }));
}
