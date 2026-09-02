import type { StateLedger } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { mergeLedgers, mergeRecords } from '../packages/agent-core/src/pipeline/ledger-merge.js';

function emptyLedger(): StateLedger {
  return { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] };
}

describe('mergeRecords (pure)', () => {
  it('归并两条记录数组，相同 key 后项浅覆盖前项', () => {
    const base = [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 }
    ];
    const addition = [
      { id: 'a', v: 10 },
      { id: 'c', v: 3 }
    ];
    const merged = mergeRecords(base, addition, (r) => r.id);
    expect(merged).toEqual([
      { id: 'a', v: 10 },
      { id: 'b', v: 2 },
      { id: 'c', v: 3 }
    ]);
  });

  it('keyOf 失败时退化为唯一 key，不丢记录', () => {
    const base = [{ name: 'x' }, { name: 'y' }];
    const merged = mergeRecords(base, [], (_r, i) => `k-${i}`);
    expect(merged).toHaveLength(2);
  });
});

describe('mergeLedgers (pure)', () => {
  it('实体按 id 归并，存在则浅覆盖', () => {
    const base = emptyLedger();
    base.entities = [{ id: 'e1', name: 'Alice', status: 'active' }];
    const addition: Partial<StateLedger> = {
      entities: [
        { id: 'e1', name: 'Alice', status: 'edited' },
        { id: 'e2', name: 'Bob' }
      ]
    };
    const result = mergeLedgers(base, addition);
    expect(result.entities).toHaveLength(2);
    const alice = result.entities.find((e: any) => e.id === 'e1');
    expect(alice).toEqual({ id: 'e1', name: 'Alice', status: 'edited' });
  });

  it('支持旧别名 characters/items 作为输入', () => {
    const base = emptyLedger();
    const addition: any = {
      characters: [{ id: 'c1', name: 'Old' }],
      items: [{ id: 'i1', name: 'Sword' }]
    };
    const result = mergeLedgers(base, addition);
    expect(result.entities).toHaveLength(1);
    expect(result.assets).toHaveLength(1);
    expect((result.entities[0] as any).name).toBe('Old');
  });

  it('非 legacy 模式清除 characters/items/foreshadowings/modifiedChapters/modifiedDocuments 别名', () => {
    const base: any = {
      entities: [],
      assets: [],
      tracks: [],
      locations: [],
      modifiedResources: [],
      characters: [{ id: 'c1' }],
      items: [{ id: 'i1' }],
      modifiedChapters: ['ch1']
    };
    const result: any = mergeLedgers(base, {});
    expect(result.characters).toBeUndefined();
    expect(result.items).toBeUndefined();
    expect(result.modifiedChapters).toBeUndefined();
  });

  it('legacy 模式保留别名并填充 foreshadowings/modifiedChapters/modifiedDocuments', () => {
    const base: any = {
      entities: [],
      assets: [],
      tracks: [{ id: 't1', clue: 'x' }],
      locations: [],
      modifiedResources: []
    };
    const result: any = mergeLedgers(base, {}, true);
    expect(result.foreshadowings).toHaveLength(1);
    expect(result.modifiedChapters).toEqual([]);
    expect(result.modifiedDocuments).toEqual([]);
    expect(result.characters).toEqual([]);
  });

  it('modifiedResources 合并 base 与 addition（注意 || 链只取首个真值数组）', () => {
    // 原始实现用 `base.modifiedResources || base.modifiedChapters || base.modifiedDocuments`，
    // 即三者互斥、只取首个真值数组。此处 base 有 modifiedResources，addition 也有 modifiedResources，
    // 因此 addition.modifiedDocuments 被忽略（与抽取前行为一致，不应在抽取时改变）。
    const base: any = {
      entities: [],
      assets: [],
      tracks: [],
      locations: [],
      modifiedResources: ['r1'],
      modifiedChapters: ['c1']
    };
    const addition: any = { modifiedResources: ['r2'], modifiedDocuments: ['d1'] };
    const result: any = mergeLedgers(base, addition);
    expect(result.modifiedResources.sort()).toEqual(['r1', 'r2']);
    // 兼容字段不会被并入（保留原行为的可观测事实，供回归守护）
    expect((result as any).modifiedDocuments).toBeUndefined();
    expect((result as any).modifiedChapters).toBeUndefined();
  });

  it('空 base 与空 addition 返回空账本', () => {
    const result = mergeLedgers(emptyLedger(), {});
    expect(result.entities).toEqual([]);
    expect(result.assets).toEqual([]);
    expect(result.tracks).toEqual([]);
    expect(result.locations).toEqual([]);
    expect(result.modifiedResources).toEqual([]);
  });
});
