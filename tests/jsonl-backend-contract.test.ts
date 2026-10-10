import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DocumentSnapshot, SessionEntry } from '@inkpi/protocol';
import { JsonlSessionBackend } from '@inkpi/session-backends';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// JsonlSessionBackend 的恢复契约：只忽略没有换行符的损坏尾记录；
// 已提交的坏行和损坏快照必须显式报错，避免静默改变或覆盖持久化状态。
// ---------------------------------------------------------------------------
describe('JsonlSessionBackend fault-tolerance contract', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpi-jsonl-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function entry(id: string, timestamp: number, sessionId = 'sess_1'): SessionEntry {
    return {
      id,
      sessionId,
      seq: timestamp,
      parentId: null,
      timestamp,
      type: 'user_message',
      payload: { role: 'user', content: '内容' }
    } as SessionEntry;
  }

  it('initialize 创建缺失目录，重复调用安全', async () => {
    const nested = path.join(dir, 'a', 'b');
    const backend = new JsonlSessionBackend(nested);
    await backend.initialize();
    expect(fs.existsSync(nested)).toBe(true);
    await expect(backend.initialize()).resolves.toBeUndefined();
  });

  it('getEntries: 会话文件不存在时返回空数组', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();
    await expect(backend.getEntries('never_used')).resolves.toEqual([]);
  });

  it('getEntries: 按 timestamp 过滤（含等于边界）', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();
    await backend.appendEntry('sess_1', entry('e1', 100));
    await backend.appendEntry('sess_1', entry('e2', 200));
    await backend.appendEntry('sess_1', entry('e3', 300));

    await expect(backend.getEntries('sess_1')).resolves.toHaveLength(3);
    // 闭区间：timestamp >= 200 命中 e2、e3
    const filtered = await backend.getEntries('sess_1', 200);
    expect(filtered.map((e) => e.id)).toEqual(['e2', 'e3']);
  });

  it('getEntries: 内部损坏行显式失败', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();
    await backend.appendEntry('sess_1', entry('good', 100));
    const journal = path.join(dir, 'session_sess_1.jsonl');
    fs.appendFileSync(journal, '这不是合法的 JSON\n', 'utf8');
    const corrupt = fs.readFileSync(journal, 'utf8');
    await expect(backend.appendEntry('sess_1', entry('after_corruption', 200))).rejects.toThrow(/line 2/);
    expect(fs.readFileSync(journal, 'utf8')).toBe(corrupt);

    await expect(backend.getEntries('sess_1')).rejects.toThrow(/line 2/);
  });

  it('getEntries: 忽略未换行的损坏尾记录，但拒绝在其后追加', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();
    await backend.appendEntry('sess_1', entry('good', 100));
    const journal = path.join(dir, 'session_sess_1.jsonl');
    fs.appendFileSync(journal, '{"id":"interrupted"', 'utf8');

    await expect(backend.getEntries('sess_1')).resolves.toMatchObject([{ id: 'good' }]);
    const beforeAppend = fs.readFileSync(journal, 'utf8');
    await expect(backend.appendEntry('sess_1', entry('next', 200))).rejects.toThrow(/final JSONL record is incomplete/);
    expect(fs.readFileSync(journal, 'utf8')).toBe(beforeAppend);
  });

  it('appendEntry: 在有效但未换行的尾记录后插入分隔符', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();
    const journal = path.join(dir, 'session_sess_1.jsonl');
    fs.writeFileSync(journal, JSON.stringify(entry('first', 100)), 'utf8');

    await backend.appendEntry('sess_1', entry('second', 200));

    await expect(backend.getEntries('sess_1')).resolves.toMatchObject([{ id: 'first' }, { id: 'second' }]);
  });

  it('getSnapshot: 文件不存在返回 null', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();
    await expect(backend.getSnapshot('nope')).resolves.toBeNull();
  });

  it('getSnapshot / saveSnapshot: 损坏快照显式失败且保留原文件', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();
    const snapshotPath = path.join(dir, 'snapshots.json');
    fs.writeFileSync(snapshotPath, '{ 损坏内容', 'utf8');
    const original = fs.readFileSync(snapshotPath, 'utf8');

    await expect(backend.getSnapshot('doc_1')).rejects.toThrow(/corrupt/i);

    const snapshot: DocumentSnapshot = {
      documentId: 'doc_1',
      contentMarkdown: '江湖夜雨十年灯',
      updatedAt: 1000
    } as DocumentSnapshot;
    await expect(backend.saveSnapshot(snapshot)).rejects.toThrow(/corrupt/i);
    await expect(backend.search('江湖')).rejects.toThrow(/corrupt/i);
    expect(fs.readFileSync(snapshotPath, 'utf8')).toBe(original);
  });

  it('appendDelta: 尊重显式传入的 id，否则自增', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();

    await backend.appendDelta({ documentId: 'd', stepJson: '{}', clientTimestamp: 1, createdAt: 1 });
    await backend.appendDelta({ documentId: 'd', stepJson: '{}', clientTimestamp: 2, createdAt: 2 });
    let deltas = await backend.getDeltas('d');
    expect(deltas.map((d) => d.id)).toEqual([1, 2]);

    // 显式 id 不被自增逻辑覆盖
    await backend.appendDelta({ documentId: 'd', id: 99, stepJson: '{}', clientTimestamp: 3, createdAt: 3 });
    deltas = await backend.getDeltas('d');
    expect(deltas.map((d) => d.id)).toEqual([1, 2, 99]);
  });

  it('getDeltas: 文件不存在返回空数组；已提交的损坏行显式失败', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();
    await expect(backend.getDeltas('missing_doc')).resolves.toEqual([]);

    await backend.appendDelta({ documentId: 'd2', stepJson: '{}', clientTimestamp: 1, createdAt: 1 });
    fs.appendFileSync(path.join(dir, 'deltas_d2.jsonl'), '坏行\n', 'utf8');
    await expect(backend.getDeltas('d2')).rejects.toThrow(/line 2/);
  });

  it('search: 无快照文件返回空；损坏文件显式失败；limit 生效', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();
    await expect(backend.search('江湖')).resolves.toEqual([]);

    for (const id of ['doc_a', 'doc_b', 'doc_c']) {
      await backend.saveSnapshot({
        documentId: id,
        contentMarkdown: '江湖夜雨十年灯',
        updatedAt: 1
      } as DocumentSnapshot);
    }
    const all = await backend.search('江湖');
    expect(all.length).toBe(3);
    expect(all[0].orderIndex).toBe(1);

    const limited = await backend.search('江湖', 2);
    expect(limited.length).toBe(2);

    fs.writeFileSync(path.join(dir, 'snapshots.json'), '损坏', 'utf8');
    await expect(backend.search('江湖')).rejects.toThrow(/corrupt/i);
  });

  it('close: jsonl 无持久连接，close 后数据仍可重新读回（与 memory 的破坏性 close 不同）', async () => {
    const backend = new JsonlSessionBackend(dir);
    await backend.initialize();
    await backend.appendEntry('sess_1', entry('persisted', 100));
    await backend.close();

    const reopened = new JsonlSessionBackend(dir);
    await reopened.initialize();
    await expect(reopened.getEntries('sess_1')).resolves.toHaveLength(1);
  });
});
