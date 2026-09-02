import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { ISessionBackend } from '@inkpi/session-backends';
import {
  MemorySessionBackend,
  JsonlSessionBackend,
  SqliteSessionBackend
} from '@inkpi/session-backends';
import type { SessionEntry, DocumentSnapshot, DocumentDelta } from '@inkpi/protocol';

describe('Pluggable Session Backends Conformance Suite (LSP Verification)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpi-backend-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup
      }
    }
  });

  const backends: Array<{ name: string; create: () => ISessionBackend }> = [
    {
      name: 'MemorySessionBackend',
      create: () => new MemorySessionBackend()
    },
    {
      name: 'JsonlSessionBackend',
      create: () => new JsonlSessionBackend(tmpDir)
    },
    {
      name: 'SqliteSessionBackend',
      create: () => new SqliteSessionBackend({ dbPath: path.join(tmpDir, 'test.db') })
    }
  ];

  for (const { name, create } of backends) {
    describe(`Backend: ${name}`, () => {
      it('should implement the full ISessionBackend lifecycle and operations consistently', async () => {
        const backend = create();
        await backend.initialize();

        // 1. Journal entries
        const entry1: SessionEntry = {
          id: 'ent_1',
          sessionId: 'sess_1',
          seq: 1,
          parentId: null,
          timestamp: 1000,
          type: 'user_message',
          payload: { role: 'user', content: '第一幕故事' }
        };
        const entry2: SessionEntry = {
          id: 'ent_2',
          sessionId: 'sess_1',
          seq: 2,
          parentId: 'ent_1',
          timestamp: 2000,
          type: 'agent_turn',
          payload: { role: 'assistant', content: '续写内容' }
        };
        const entryOther: SessionEntry = {
          id: 'ent_3',
          sessionId: 'sess_2',
          seq: 1,
          parentId: null,
          timestamp: 1500,
          type: 'user_message',
          payload: { role: 'user', content: '另外的会话' }
        };

        await backend.appendEntry('sess_1', entry1);
        await backend.appendEntry('sess_1', entry2);
        await backend.appendEntry('sess_2', entryOther);

        const allSess1 = await backend.getEntries('sess_1');
        expect(allSess1.length).toBe(2);
        expect(allSess1[0].timestamp).toBe(1000);
        expect(allSess1[1].timestamp).toBe(2000);

        const filteredSess1 = await backend.getEntries('sess_1', 1500);
        expect(filteredSess1.length).toBe(1);
        expect(filteredSess1[0].timestamp).toBe(2000);

        // 2. Document snapshots
        const snapshot: DocumentSnapshot = {
          documentId: 'doc_alpha',
          version: 1,
          contentJson: JSON.stringify({ type: 'doc', text: '风起云涌' }),
          contentMarkdown: '# 风起云涌\n\n天下英雄出我辈，一入江湖岁月催。',
          contentSize: 25,
          updatedAt: 3000
        };

        await backend.saveSnapshot(snapshot);
        const fetchedSnap = await backend.getSnapshot('doc_alpha');
        expect(fetchedSnap).not.toBeNull();
        expect(fetchedSnap!.documentId).toBe('doc_alpha');
        expect(fetchedSnap!.contentMarkdown).toContain('天下英雄出我辈');

        const missingSnap = await backend.getSnapshot('doc_non_existent');
        expect(missingSnap).toBeNull();

        // 3. Document deltas
        const delta1: DocumentDelta = {
          documentId: 'doc_alpha',
          stepJson: JSON.stringify({ insert: '皇图霸业谈笑中' }),
          clientTimestamp: 3100,
          createdAt: 3100
        };
        const delta2: DocumentDelta = {
          documentId: 'doc_alpha',
          stepJson: JSON.stringify({ insert: '不胜人生一场醉' }),
          clientTimestamp: 3200,
          createdAt: 3200
        };

        await backend.appendDelta(delta1);
        await backend.appendDelta(delta2);

        const deltas = await backend.getDeltas('doc_alpha');
        expect(deltas.length).toBe(2);
        expect(deltas[0].documentId).toBe('doc_alpha');

        const filteredDeltas = await backend.getDeltas('doc_alpha', 2);
        // LSP: all backends must agree on `id >= fromId` (inclusive) semantics.
        // Two deltas were appended (auto ids 1, 2), so only id >= 2 is returned.
        expect(filteredDeltas.length).toBe(1);
        expect(filteredDeltas.every((d) => (d.id ?? 0) >= 2)).toBe(true);

        // 4. Search capability
        if (backend.search) {
          const results = await backend.search('江湖', 5);
          expect(results.length).toBeGreaterThan(0);
          expect(results[0].documentId).toBe('doc_alpha');
        }

        await backend.close();
      });
    });
  }

});
