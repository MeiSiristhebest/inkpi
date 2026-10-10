import { assertJsonValue } from './json.js';

export type DomainChangeOperation = 'upsert' | 'delete';

export interface DomainChange {
  id: string;
  aggregateType: string;
  aggregateId: string;
  operation: DomainChangeOperation;
  revision: number;
  payload?: unknown;
  occurredAt: number;
}

/**
 * An append-only batch emitted by the desktop's authoritative IndexedDB.
 * The daemon stores this data as a derived projection and never becomes the
 * source of truth for document edits.
 */
export interface DomainChangeSet {
  id: string;
  workspaceId: string;
  sourceDeviceId: string;
  baseRevision: number;
  revision: number;
  changes: DomainChange[];
  checksum: string;
  createdAt: number;
}

export interface DomainProjectionCursor {
  workspaceId: string;
  revision: number;
  updatedAt: number;
}

export interface DomainProjectionApplyResult {
  accepted: boolean;
  duplicate: boolean;
  workspaceId: string;
  revision: number;
  reason?: 'revision-conflict' | 'invalid-change-set';
}

export interface DomainSyncPushParams {
  changeSet: DomainChangeSet;
}

export interface DomainSyncPullParams {
  workspaceId: string;
  afterRevision?: number;
}

export interface DomainProjectionSnapshot {
  workspaceId: string;
  revision: number;
  changeSets: DomainChangeSet[];
  createdAt: number;
  /** Host-owned history generation; changes when a snapshot replaces the log. */
  epoch?: string;
}

export interface DomainSyncPageParams {
  workspaceId: string;
  afterRevision: number;
  epoch: string;
  limit?: number;
}
export interface DomainSyncPage {
  workspaceId: string;
  afterRevision: number;
  revision: number;
  epoch: string;
  reset: boolean;
  changeSets: DomainChangeSet[];
}

/** Restore the historical optional delete field dropped by a JSON wire hop. */
export function restoreDomainChangeSetWireValue(input: DomainChangeSet): DomainChangeSet {
  const { changes, ...metadata } = input;
  assertJsonValue(metadata, 'Domain change set metadata');
  if (!Array.isArray(changes)) throw new Error('Domain change set has invalid changes');
  for (const change of changes) {
    const { payload, ...changeMetadata } = change;
    assertJsonValue(changeMetadata, 'Domain change metadata');
    if (change.operation !== 'delete' || payload !== undefined) assertJsonValue(payload, 'Domain change payload');
  }
  const changeSet = structuredClone(input);
  const { checksum, ...unsigned } = changeSet;
  if (calculateDomainChangeSetChecksum(unsigned) === checksum) return changeSet;
  if (Array.isArray(changeSet.changes)) {
    changeSet.changes = changeSet.changes.map((change) =>
      change.operation === 'delete' && !Object.hasOwn(change, 'payload') ? { ...change, payload: undefined } : change
    );
  }
  const { checksum: _checksum, ...legacy } = changeSet;
  if (calculateDomainChangeSetChecksum(legacy) !== checksum) throw new Error('Domain change set checksum mismatch');
  return changeSet;
}

export interface DomainSyncSnapshotParams {
  workspaceId: string;
}

export interface DomainSyncRestoreParams {
  snapshot: DomainProjectionSnapshot;
}

/**
 * Calculates a deterministic checksum over the change-set payload. The
 * checksum deliberately excludes the checksum field itself so both desktop
 * and daemon can verify the same wire object without a shared mutable state.
 */
export function calculateDomainChangeSetChecksum(changeSet: Omit<DomainChangeSet, 'checksum'>): string {
  const serialized = stableSerialize(changeSet);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}
