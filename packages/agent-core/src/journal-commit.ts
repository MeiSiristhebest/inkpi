import { SessionCommitError } from '@inkpi/protocol';
import type { AgentMessage, JournalAppend, JournalEntry } from '@inkpi/protocol';
import type { AgentOptions, AgentState } from './types.js';

const writers = new WeakMap<object, { tail: Promise<void>; fault?: SessionCommitError }>();

/** Persist the transition before exposing it. Legacy writers remain sequential. */
export async function commitJournal(
  journal: AgentOptions['journal'],
  appends: readonly JournalAppend[]
): Promise<JournalEntry[]> {
  if (!journal) return [];
  let writer = writers.get(journal);
  if (!writer) {
    writer = { tail: Promise.resolve() };
    writers.set(journal, writer);
  }
  const queue = writer;
  const commit = queue.tail.then(async () => {
    if (queue.fault) throw queue.fault;
    let appended = 0;
    try {
      if (journal.appendBatch) return await journal.appendBatch(appends);
      const entries: JournalEntry[] = [];
      for (const append of appends) {
        const entry = await journal.append(append.type, append.payload, append.id, append.parentId);
        appended++;
        if (entry && typeof entry.id === 'string') entries.push(entry);
      }
      return entries;
    } catch (error) {
      const failure =
        error instanceof SessionCommitError && appended === 0
          ? error
          : new SessionCommitError(error instanceof Error ? error.message : String(error), 'unknown', { cause: error });
      if (failure.certainty === 'unknown') queue.fault = failure;
      throw failure;
    }
  });
  queue.tail = commit.then(
    () => undefined,
    () => undefined
  );
  return commit;
}

export async function commitMessage(journal: AgentOptions['journal'], message: AgentMessage): Promise<AgentMessage> {
  const type =
    message.role === 'user'
      ? 'user_message'
      : message.role === 'assistant'
        ? 'agent_turn'
        : message.role === 'toolResult'
          ? 'tool_execution'
          : 'custom';
  const entries = await commitJournal(journal, [{ type, payload: message }]);
  return entries[0] ? { ...message, id: entries[0].id } : message;
}

export function adoptMessage(state: AgentState, journal: AgentOptions['journal'], message: AgentMessage): void {
  try {
    state.messages.push(message);
  } catch (error) {
    if (!journal) throw error;
    throw new SessionCommitError('Message committed but state adoption failed; reconstruct the session.', 'unknown', {
      cause: error
    });
  }
}
