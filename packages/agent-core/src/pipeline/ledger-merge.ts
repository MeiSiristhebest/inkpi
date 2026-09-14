import type { RuntimeState, WorkflowStateAdapter } from '@inkpi/protocol';

/** Create the empty opaque state used by a generic workflow. */
export function emptyRuntimeState(): RuntimeState {
  return {};
}

/** Merge opaque runtime state without interpreting product-domain fields. */
export function mergeRuntimeState(base: RuntimeState, addition: unknown): RuntimeState {
  const patch = isRecord(addition) ? addition : {};
  const result: RuntimeState = { ...base, ...patch };

  for (const [key, value] of Object.entries(patch)) {
    const previous = base[key];
    if (Array.isArray(previous) && Array.isArray(value)) {
      result[key] = mergeRuntimeCollection(previous, value);
    }
  }

  return result;
}

/** Default adapter used by generic workflows when no state adapter is supplied. */
export const genericRuntimeStateAdapter: WorkflowStateAdapter = {
  createInitialState: emptyRuntimeState,
  merge: mergeRuntimeState
};

/** @deprecated Use mergeRuntimeState(); retained as a domain-neutral source alias. */
export const mergeLedgers = mergeRuntimeState;

/** Merge two record arrays by an explicit caller-supplied identity function. */
export function mergeRecords<T extends object>(
  base: T[],
  addition: T[],
  keyOf: (record: T, index: number) => string
): T[] {
  const records = new Map<string, T>();
  for (const [index, record] of [...base, ...addition].entries()) {
    const key = keyOf(record, index);
    const previous = records.get(key);
    records.set(key, previous ? { ...previous, ...record } : { ...record });
  }
  return Array.from(records.values());
}

function mergeRuntimeCollection(base: unknown[], addition: unknown[]): unknown[] {
  if (!base.every(isRecord) || !addition.every(isRecord)) {
    return [...new Set([...base, ...addition])];
  }

  const records = new Map<string, Record<string, unknown>>();
  for (const [index, record] of [...base, ...addition].entries()) {
    const key = recordIdentity(record, index);
    const previous = records.get(key);
    records.set(key, previous ? { ...previous, ...record } : { ...record });
  }
  return Array.from(records.values());
}

function recordIdentity(record: Record<string, unknown>, index: number): string {
  for (const key of ['id', 'key', 'name']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return `${key}:${value}`;
  }
  return `index:${index}:${JSON.stringify(record)}`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
