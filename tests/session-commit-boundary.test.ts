import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import { SessionCommitError } from '@inkpi/protocol';
import type { AgentEvent, AgentTool, JournalAppend, JournalEntry } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function journalFile(): { sessionId: string; filePath: string } {
  const directory = mkdtempSync(join(tmpdir(), 'inkpi-commit-'));
  directories.push(directory);
  return { sessionId: 'transaction', filePath: join(directory, 'session.jsonl') };
}
function answer(): AssistantEventStream {
  const stream = new AssistantEventStream();
  stream.push({ type: 'text_delta', textDelta: 'answer' });
  stream.end();
  return stream;
}

describe('commit before session adoption and publication', () => {
  it('marks a committed input adoption failure as requiring reconstruction', async () => {
    const journal = new AppendOnlySessionJournal('frozen-state');
    const agent = new Agent({ initialState: { model: getModelPreset('mock-test') }, journal, streamFn: answer });
    Object.freeze(agent.state.messages);
    await expect(agent.prompt('committed input')).rejects.toThrow('state adoption failed');
    expect(journal.getEntriesByType('user_message')).toHaveLength(1);
    expect(agent.state.isFaulted).toBe(true);
    await expect(agent.continue()).rejects.toThrow('Reconstruct');
  });

  it('propagates failed durable frame writes after draining asynchronous stream listeners', async () => {
    const journal = {
      append: async (type: string) => {
        if (type === 'assistant_frame') throw new SessionCommitError('frame persistence failed', 'unknown');
      }
    };
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      journal,
      streamFn: () => {
        const stream = new AssistantEventStream();
        setTimeout(() => {
          stream.push({ type: 'text_delta', textDelta: 'streamed' });
          stream.end();
        }, 0);
        return stream;
      }
    });
    await expect(agent.prompt('input')).rejects.toThrow('frame persistence failed');
    expect(agent.state.messages).toHaveLength(1);
    expect(agent.state.isFaulted).toBe(true);
  });

  it('atomically persists a settlement and result and rejects the whole invalid batch', () => {
    const options = journalFile();
    const journal = new AppendOnlySessionJournal(options);
    const committed = journal.appendBatch([
      { type: 'operation_settlement', payload: { id: 'op' }, id: 'settled' },
      { type: 'agent_turn', payload: { text: 'answer' }, id: 'answer' }
    ]);
    expect(committed[1]).toMatchObject({ seq: 2, parentId: 'settled' });
    expect(readFileSync(options.filePath, 'utf8').trim().split('\n')).toHaveLength(1);
    const before = readFileSync(options.filePath, 'utf8');
    expect(() =>
      journal.appendBatch([
        { type: 'custom', payload: {}, id: 'new' },
        { type: 'custom', payload: {}, id: 'answer' }
      ])
    ).toThrow(SessionCommitError);
    expect(journal.count()).toBe(2);
    expect(readFileSync(options.filePath, 'utf8')).toBe(before);
    expect(new AppendOnlySessionJournal(options).getEntries()).toEqual(committed);
  });

  it('discards an uncommitted batch tail and rejects complete corrupted batch records', () => {
    const options = journalFile();
    const journal = new AppendOnlySessionJournal(options);
    journal.append('user_message', { content: 'input' });
    const prefix = readFileSync(options.filePath, 'utf8');
    appendFileSync(options.filePath, '{"journalBatch":1,"entries":[{"id":"complete-child"},');
    expect(new AppendOnlySessionJournal(options).count()).toBe(1);
    expect(readFileSync(options.filePath, 'utf8')).toBe(prefix);
    appendFileSync(options.filePath, '{"journalBatch":2,"entries":[]}\n');
    expect(() => new AppendOnlySessionJournal(options)).toThrow('Invalid journal batch');
  });

  it('waits for input commit before exposing input or requesting the provider', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: AgentEvent[] = [];
    let requests = 0;
    const journal = {
      appendBatch: async (entries: JournalAppend[]) => {
        if (entries[0].type === 'user_message') await gate;
        return [];
      }
    };
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      journal,
      streamFn: () => {
        requests++;
        return answer();
      }
    });
    agent.subscribe((event) => {
      events.push(event);
    });
    const run = agent.prompt('input');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(agent.state.messages).toEqual([]);
    expect(events).toEqual([]);
    expect(requests).toBe(0);
    release();
    await run;
    expect(requests).toBe(1);
    expect(agent.state.messages).toHaveLength(2);
  });

  it('recovers committed results after adoption failure and forbids further writes in the failed session', async () => {
    const options = journalFile();
    class FailedAdoptionJournal extends AppendOnlySessionJournal {
      override appendBatch(entries: readonly JournalAppend[]): JournalEntry[] {
        const result = super.appendBatch(entries);
        if (entries.some((entry) => entry.type === 'agent_turn'))
          throw new SessionCommitError('adoption failed after commit', 'unknown');
        return result;
      }
    }
    const journal = new FailedAdoptionJournal(options);
    const published: AgentEvent[] = [];
    const agent = new Agent({ initialState: { model: getModelPreset('mock-test') }, journal, streamFn: answer });
    agent.subscribe((event) => {
      published.push(event);
    });
    await expect(agent.prompt('input')).rejects.toThrow('adoption failed');
    expect(agent.state.isFaulted).toBe(true);
    expect(agent.state.messages).toHaveLength(1);
    expect(published.filter((event) => event.type === 'message_end' && event.message.role === 'assistant')).toEqual([]);
    const count = journal.count();
    await expect(agent.continue()).rejects.toThrow('Reconstruct');
    expect(journal.count()).toBe(count);
    expect(new AppendOnlySessionJournal(options).getEntriesByType('agent_turn')).toHaveLength(1);
  });

  it('allows retry after an explicit atomic rollback rejection', async () => {
    let reject = true;
    class RejectedJournal extends AppendOnlySessionJournal {
      override appendBatch(entries: readonly JournalAppend[]): JournalEntry[] {
        if (reject && entries.some((entry) => entry.type === 'agent_turn'))
          throw new SessionCommitError('batch rejected', 'rejected');
        return super.appendBatch(entries);
      }
    }
    const journal = new RejectedJournal('rejected');
    const agent = new Agent({ initialState: { model: getModelPreset('mock-test') }, journal, streamFn: answer });
    await expect(agent.prompt('input')).rejects.toThrow('batch rejected');
    expect(agent.state.isFaulted).not.toBe(true);
    expect(journal.getEntriesByType('operation_settlement')).toHaveLength(0);
    reject = false;
    await agent.continue();
    expect(journal.getEntriesByType('agent_turn')).toHaveLength(1);
  });

  it('never publishes tool completion when its result transaction fails', async () => {
    let effects = 0;
    const tool: AgentTool = {
      name: 'effect',
      description: 'effect',
      parameters: { type: 'object' },
      replay: 'never',
      execute: async () => {
        effects++;
        return { content: [{ type: 'text', text: 'done' }] };
      }
    };
    class FailedResultJournal extends AppendOnlySessionJournal {
      override appendBatch(entries: readonly JournalAppend[]): JournalEntry[] {
        if (entries.some((entry) => entry.type === 'tool_execution'))
          throw new SessionCommitError('unknown tool result commit', 'unknown');
        return super.appendBatch(entries);
      }
    }
    const published: AgentEvent[] = [];
    const journal = new FailedResultJournal('tool-result');
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test'), tools: [tool] },
      journal,
      streamFn: () => {
        const stream = new AssistantEventStream();
        stream.push({ type: 'tool_call_start', toolCallId: 'call', toolName: 'effect' });
        stream.push({
          type: 'tool_call_end',
          toolCall: { type: 'toolCall', id: 'call', name: 'effect', arguments: {} }
        });
        stream.end();
        return stream;
      }
    });
    agent.subscribe((event) => {
      published.push(event);
    });
    await expect(agent.prompt('execute')).rejects.toThrow('unknown tool result');
    expect(effects).toBe(1);
    expect(agent.state.isFaulted).toBe(true);
    expect(agent.state.messages.some((message) => message.role === 'toolResult')).toBe(false);
    expect(published.some((event) => event.type === 'tool_execution_end')).toBe(false);
  });
});
