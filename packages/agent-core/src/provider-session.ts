import type { SessionEntry } from '@inkpi/protocol';

/** Restore only a journal's explicit provider identity, never its product/user ID. */
export function restoreProviderSessionId(entries: readonly SessionEntry[]): string | undefined {
  let entry: SessionEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].type === 'provider_session') {
      entry = entries[index];
      break;
    }
  }
  if (!entry) return undefined;
  if (entry.payload?.version !== 1 || typeof entry.payload.id !== 'string' || !entry.payload.id.trim()) {
    throw new Error(`Invalid provider session identity in '${entry.id}'.`);
  }
  return entry.payload.id;
}
