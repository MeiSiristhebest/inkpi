import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DocumentDelta, DocumentSnapshot, SessionEntry } from '@inkpi/protocol';
import {
  BackendClosedError,
  type ISessionBackend,
  JsonlSessionBackend,
  MemorySessionBackend,
  SqliteSessionBackend
} from '@inkpi/session-backends';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `ISessionBackend.close()` 后置条件契约守卫测试（C8）。
 *
 * 契约对所有后端一致：
 *  - `close()` 幂等（重复调用不抛错、无副作用）；
 *  - 终止态下调用任意其它方法（含 `initialize`）必须以 `BackendClosedError` 拒绝。
 *
 * 以 Memory / Jsonl / Sqlite 三个后端为参数化实现，验证契约落地一致。
 * 各后端的"破坏性"语义可不同（Memory 丢弃数据 / Jsonl·Sqlite 仅释放连接），
 * 但"终止态拒绝后续调用"对所有后端一致。
 */
type BackendName = 'memory' | 'jsonl' | 'sqlite';

interface Harness {
  name: BackendName;
  create: () => ISessionBackend;
  cleanup?: () => void;
}

function makeHarnesses(): Harness[] {
  const harnesses: Harness[] = [
    { name: 'memory', create: () => new MemorySessionBackend() },
    { name: 'sqlite', create: () => new SqliteSessionBackend({ dbPath: ':memory:' }) }
  ];
  // Jsonl 需要一个真实目录，测试后清理。
  const jsonlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpi-jsonl-close-'));
  harnesses.push({
    name: 'jsonl',
    create: () => new JsonlSessionBackend(jsonlDir),
    cleanup: () => fs.rmSync(jsonlDir, { recursive: true, force: true })
  });
  return harnesses;
}

const entry = (id: string, ts: number): SessionEntry => ({
  id,
  sessionId: 'sess_1',
  seq: 1,
  parentId: null,
  type: 'user_message',
  timestamp: ts,
  payload: {}
});
const snapshot: DocumentSnapshot = {
  documentId: 'doc_1',
  version: 1,
  contentJson: '{}',
  contentMarkdown: '江湖',
  contentSize: 2,
  updatedAt: 1
};
const delta: DocumentDelta = {
  documentId: 'doc_1',
  stepJson: '{}',
  clientTimestamp: 1,
  createdAt: 1
};

for (const h of makeHarnesses()) {
  describe(`SessionBackend.close() post-condition contract on ${h.name} (C8)`, () => {
    afterEach(() => h.cleanup?.());

    it('close() is idempotent', async () => {
      const backend = h.create();
      await backend.initialize();
      await backend.close();
      await expect(backend.close()).resolves.toBeUndefined();
    });

    it('rejects every other method after close() with BackendClosedError', async () => {
      const backend = h.create();
      await backend.initialize();
      await backend.appendEntry('sess_1', entry('e1', 100));
      await backend.close();

      await expect(backend.initialize()).rejects.toBeInstanceOf(BackendClosedError);
      await expect(backend.appendEntry('sess_1', entry('e2', 200))).rejects.toBeInstanceOf(BackendClosedError);
      await expect(backend.getEntries('sess_1')).rejects.toBeInstanceOf(BackendClosedError);
      await expect(backend.saveSnapshot(snapshot)).rejects.toBeInstanceOf(BackendClosedError);
      await expect(backend.getSnapshot('doc_1')).rejects.toBeInstanceOf(BackendClosedError);
      await expect(backend.appendDelta(delta)).rejects.toBeInstanceOf(BackendClosedError);
      await expect(backend.getDeltas('doc_1')).rejects.toBeInstanceOf(BackendClosedError);
      await expect(backend.search('江湖')).rejects.toBeInstanceOf(BackendClosedError);
    });

    it('does not leak state across a closed backend', async () => {
      const backend = h.create();
      await backend.initialize();
      await backend.appendEntry('sess_1', entry('e1', 100));
      await backend.close();
      // 终止态拒绝读取，旧数据不应以任何方式外泄。
      await expect(backend.getEntries('sess_1')).rejects.toBeInstanceOf(BackendClosedError);
    });
  });
}
