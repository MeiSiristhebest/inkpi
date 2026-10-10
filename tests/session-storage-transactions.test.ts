import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionEntry } from '@inkpi/protocol';
import {
  type ISessionBackend,
  JsonlSessionBackend,
  MemorySessionBackend,
  type SessionEntryCursor,
  SqliteSessionBackend
} from '@inkpi/session-backends';
import { InkDb } from '@inkpi/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({ rename: false, flush: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    fsyncSync: (...args: Parameters<typeof fs.fsyncSync>) => {
      if (faults.flush) throw new Error('flush outcome unknown');
      return actual.fsyncSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      if (faults.rename) throw new Error('rename rejected');
      return actual.renameSync(...args);
    }
  };
});

let dir: string;
const opened: ISessionBackend[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpi-storage-atomic-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  faults.rename = false;
  faults.flush = false;
  for (const backend of opened.splice(0)) await backend.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function entry(id: string, seq: number, parentId: string | null = null, sessionId = 'source'): SessionEntry {
  return {
    id,
    seq,
    parentId,
    sessionId,
    timestamp: 100 - seq,
    type: 'user_message',
    payload: { content: [{ text: id }], firstKeptEntryId: parentId },
    version: 1,
    hash: `hash-${id}`,
    laneId: 'lane',
    operationId: 'op'
  };
}

for (const name of ['memory', 'jsonl', 'sqlite'] as const) {
  async function create(): Promise<ISessionBackend> {
    const backend =
      name === 'memory'
        ? new MemorySessionBackend()
        : name === 'jsonl'
          ? new JsonlSessionBackend(dir)
          : new SqliteSessionBackend({ dbPath: path.join(dir, 'state.db') });
    opened.push(backend);
    await backend.initialize();
    return backend;
  }
  describe(`${name} session transaction contract`, () => {
    it('rejects the entire append/import before changing data and never overwrites an ID', async () => {
      const backend = await create();
      const original = entry('a', 1);
      await backend.appendEntry('source', original);
      for (const invalid of [
        entry('a', 3),
        entry('b', 1),
        entry('b', 3, 'missing'),
        entry('b', 3, 'a', 'other'),
        { ...entry('b', 3, 'a'), version: 2 }
      ]) {
        await expect(backend.appendEntries('source', [entry('staged', 2, 'a'), invalid])).rejects.toThrow();
        expect(await backend.getEntries('source')).toStrictEqual([original]);
      }
      await expect(backend.loadEntries('source', [entry('staged', 2, 'a'), entry('a', 3)])).rejects.toThrow();
      expect(await backend.getEntries('source')).toStrictEqual([original]);
      await backend.appendEntries('source', [entry('b', 5, 'a'), entry('c', 8, 'b')]);
      expect((await backend.getEntries('source')).map((record) => record.seq)).toEqual([1, 5, 8]);
    });

    it('isolates nested inputs and all returned views from stored history', async () => {
      const backend = await create();
      const input = [entry('a', 1), entry('b', 2, 'a')];
      await backend.loadEntries('source', input);
      input[0].payload.content[0].text = 'changed input';
      const read = await backend.getEntries('source');
      read[0].payload.content[0].text = 'changed output';
      const page = await backend.getEntryPage('source', { limit: 1 });
      page.entries[0].payload.content[0].text = 'changed page';
      expect((await backend.getEntries('source'))[0].payload.content[0].text).toBe('a');
    });

    it('pages in either sequence direction within a fixed boundary despite new appends', async () => {
      const backend = await create();
      const initial = Array.from({ length: 7 }, (_, index) =>
        entry(`e${index + 1}`, index + 1, index ? `e${index}` : null)
      );
      await backend.appendEntries('source', initial);
      const forward = await backend.getEntryPage('source', { limit: 2 });
      const backward = await backend.getEntryPage('source', { limit: 2, direction: 'backward' });
      await backend.appendEntry('source', entry('later', 8, 'e7'));
      async function drain(first: typeof forward): Promise<string[]> {
        const ids = first.entries.map((record) => record.id);
        let cursor: SessionEntryCursor | null = first.nextCursor;
        while (cursor) {
          const page = await backend.getEntryPage('source', { cursor, limit: 2 });
          ids.push(...page.entries.map((record) => record.id));
          cursor = page.nextCursor;
        }
        return ids;
      }
      expect(await drain(forward)).toEqual(initial.map((record) => record.id));
      expect(await drain(backward)).toEqual(initial.map((record) => record.id).reverse());
      await expect(backend.getEntryPage('other', { cursor: forward.nextCursor! })).rejects.toThrow(/cursor/i);
      await expect(
        backend.getEntryPage('source', { cursor: forward.nextCursor!, direction: 'backward' })
      ).rejects.toThrow(/cursor/i);
      await expect(
        backend.getEntryPage('source', { cursor: { ...forward.nextCursor!, lastId: 'missing' } })
      ).rejects.toThrow(/cursor/i);
      await expect(backend.getEntryPage('source', { limit: 1001 })).rejects.toThrow(/limit/i);
    });

    it('forks all history or an ancestor path without replacing IDs, metadata or the source', async () => {
      const backend = await create();
      const entries = [
        entry('root', 1),
        entry('left', 2, 'root'),
        entry('right', 3, 'root'),
        {
          ...entry('summary', 4, 'right'),
          type: 'compaction' as const,
          payload: { firstKeptEntryId: 'right', summary: 'retained', details: { nested: ['a'] } }
        }
      ];
      await backend.loadEntries('source', entries);
      await backend.forkSession('source', 'archive');
      await backend.forkSession('source', 'branch', 'summary');
      expect(await backend.getEntries('archive')).toStrictEqual(
        entries.map((record) => ({ ...record, sessionId: 'archive' }))
      );
      expect(await backend.getEntries('branch')).toStrictEqual(
        [entries[0], entries[2], entries[3]].map((record) => ({ ...record, sessionId: 'branch' }))
      );
      expect(await backend.getEntries('source')).toStrictEqual(entries);
      await expect(backend.forkSession('source', 'archive')).rejects.toThrow(/empty/);
      await expect(backend.forkSession('source', 'missing-head', 'missing')).rejects.toThrow(/head/);
      expect(await backend.getEntries('missing-head')).toEqual([]);
    });
  });
}

it('JSONL drops an entire torn batch, rejects complete corruption, and preserves legacy entries', async () => {
  const backend = new JsonlSessionBackend(dir);
  opened.push(backend);
  await backend.initialize();
  const journal = path.join(dir, 'session_source.jsonl');
  fs.writeFileSync(journal, `${JSON.stringify(entry('legacy', 1))}\n`);
  await backend.appendEntries('source', [entry('b', 2, 'legacy'), entry('c', 3, 'b')]);
  const committed = fs.readFileSync(journal, 'utf8');
  expect(committed.split('\n').filter(Boolean)).toHaveLength(2);
  const pending = JSON.stringify({ journalBatch: 1, entries: [entry('d', 4, 'c'), entry('e', 5, 'd')] });
  fs.appendFileSync(journal, pending.slice(0, -10));
  expect((await backend.getEntries('source')).map((record) => record.id)).toEqual(['legacy', 'b', 'c']);
  await expect(backend.appendEntry('source', entry('next', 6, 'c'))).rejects.toThrow(/incomplete/);
  fs.writeFileSync(journal, `${committed}${pending.slice(0, -10)}\n`);
  await expect(backend.getEntries('source')).rejects.toThrow(/line 3/);
});

it('SQLite rolls back an actual mid-batch insert failure and preserves it after reopening', async () => {
  const dbPath = path.join(dir, 'fault.db');
  const backend = new SqliteSessionBackend({ dbPath });
  opened.push(backend);
  await backend.initialize();
  const control = new InkDb(dbPath);
  control.exec(
    "CREATE TRIGGER reject_second BEFORE INSERT ON session_entries WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'injected write failure'); END"
  );
  control.close();
  await expect(backend.appendEntries('source', [entry('first', 1), entry('second', 2, 'first')])).rejects.toThrow(
    /injected/
  );
  expect(await backend.getEntries('source')).toEqual([]);
  await backend.close();
  const reopened = new SqliteSessionBackend({ dbPath });
  opened.push(reopened);
  expect(await reopened.getEntries('source')).toEqual([]);
});

it('JSONL stops writes after an unknown flush outcome and reconstructs the committed batch on reopen', async () => {
  const backend = new JsonlSessionBackend(dir);
  opened.push(backend);
  await backend.initialize();
  faults.flush = true;
  const records = [entry('a', 1), entry('b', 2, 'a')];
  await expect(backend.appendEntries('source', records)).rejects.toMatchObject({ certainty: 'unknown' });
  faults.flush = false;
  const bytes = fs.readFileSync(path.join(dir, 'session_source.jsonl'), 'utf8');
  await expect(backend.appendEntry('source', entry('c', 3, 'b'))).rejects.toMatchObject({ certainty: 'unknown' });
  expect(fs.readFileSync(path.join(dir, 'session_source.jsonl'), 'utf8')).toBe(bytes);
  const reopened = new JsonlSessionBackend(dir);
  opened.push(reopened);
  expect(await reopened.getEntries('source')).toStrictEqual(records);
  await reopened.appendEntry('source', entry('c', 3, 'b'));
});

it('recovers no partial settlement after a process is killed while appending a batch', async () => {
  const backend = new JsonlSessionBackend(dir);
  opened.push(backend);
  await backend.initialize();
  await backend.appendEntry('source', entry('a', 1));
  const pending = JSON.stringify({ journalBatch: 1, entries: [entry('b', 2, 'a'), entry('c', 3, 'b')] });
  const script =
    "import fs from 'node:fs'; const fd = fs.openSync(process.argv[1], 'a'); fs.writeSync(fd, process.argv[2].slice(0, -10)); fs.fsyncSync(fd); process.kill(process.pid, 'SIGKILL');";
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script, path.join(dir, 'session_source.jsonl'), pending],
    { shell: false, timeout: 5000 }
  );
  expect(child.error).toBeUndefined();
  expect(child.status).not.toBe(0);
  const reopened = new JsonlSessionBackend(dir);
  opened.push(reopened);
  expect(await reopened.getEntries('source')).toStrictEqual([entry('a', 1)]);
});

it('JSONL snapshot replacement preserves the previous file if rename fails', async () => {
  const backend = new JsonlSessionBackend(dir);
  opened.push(backend);
  await backend.initialize();
  const old = { documentId: 'doc', version: 1, contentJson: '{}', contentMarkdown: '', contentSize: 0, updatedAt: 1 };
  await backend.saveSnapshot(old);
  const before = fs.readFileSync(path.join(dir, 'snapshots.json'), 'utf8');
  faults.rename = true;
  await expect(backend.saveSnapshot({ ...old, version: 2 })).rejects.toThrow(/rename rejected/);
  expect(fs.readFileSync(path.join(dir, 'snapshots.json'), 'utf8')).toBe(before);
  expect(fs.readdirSync(dir)).toEqual(['snapshots.json']);
});
