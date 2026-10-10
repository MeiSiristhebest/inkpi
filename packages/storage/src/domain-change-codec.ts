import { type DomainChange, assertJsonValue } from '@inkpi/protocol';

/** Versioned storage envelope; payload values never serve as encoding markers. */
export function serializeDomainChanges(changes: readonly DomainChange[]): string {
  const undefinedPayloadIndices: number[] = [];
  const values = changes.map((change, index) => {
    if (Object.hasOwn(change, 'payload') && change.payload === undefined) {
      undefinedPayloadIndices.push(index);
      const { payload: _payload, ...rest } = change;
      return rest;
    }
    return change;
  });
  const envelope = { version: 2, changes: values, undefinedPayloadIndices };
  assertJsonValue(envelope, 'Domain changes');
  return JSON.stringify(envelope);
}

export function deserializeDomainChanges(serialized: string): DomainChange[] {
  const value = JSON.parse(serialized);
  if (Array.isArray(value)) return restoreLegacyUndefined(value) as DomainChange[];
  if (value?.version !== 2 || !Array.isArray(value.changes) || !Array.isArray(value.undefinedPayloadIndices))
    throw new Error('Invalid domain change storage envelope.');
  const seen = new Set<number>();
  for (const index of value.undefinedPayloadIndices) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= value.changes.length ||
      seen.has(index) ||
      value.changes[index]?.operation !== 'delete' ||
      Object.hasOwn(value.changes[index], 'payload')
    )
      throw new Error('Invalid domain change undefined payload index.');
    seen.add(index);
    value.changes[index].payload = undefined;
  }
  return value.changes;
}

function restoreLegacyUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreLegacyUndefined);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const sentinel = '__inkpi_domain_projection_undefined__';
  if (Object.keys(record).length === 1 && record[sentinel] === true) return undefined;
  for (const key of Object.keys(record)) record[key] = restoreLegacyUndefined(record[key]);
  return record;
}
