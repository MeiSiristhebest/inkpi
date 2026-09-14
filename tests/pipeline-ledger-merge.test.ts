import type { RuntimeState } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import {
  emptyRuntimeState,
  genericRuntimeStateAdapter,
  mergeRecords,
  mergeRuntimeState
} from '../packages/agent-core/src/pipeline/ledger-merge.js';

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

describe('mergeRuntimeState (pure)', () => {
  it('按通用记录身份归并数组，存在则浅覆盖', () => {
    const base: RuntimeState = { records: [{ id: 'r1', label: 'old' }] };
    const addition: RuntimeState = {
      records: [
        { id: 'r1', label: 'updated' },
        { id: 'r2', label: 'new' }
      ]
    };
    const result = mergeRuntimeState(base, addition);
    expect(result.records).toEqual([
      { id: 'r1', label: 'updated' },
      { id: 'r2', label: 'new' }
    ]);
  });

  it('保留任意 opaque key，不读取或制造产品域别名', () => {
    const base: RuntimeState = { counters: [1, 2], opaque: { source: 'base' } };
    const result = mergeRuntimeState(base, { counters: [2, 3], extra: true });
    expect(result.counters).toEqual([1, 2, 3]);
    expect(result.opaque).toEqual({ source: 'base' });
    expect(result.extra).toBe(true);
  });

  it('非对象 patch 不改变 state', () => {
    const base: RuntimeState = { value: 1 };
    expect(mergeRuntimeState(base, null)).toEqual(base);
    expect(mergeRuntimeState(base, 'ignored')).toEqual(base);
  });

  it('默认 adapter 提供空初始状态和 generic merge', () => {
    expect(emptyRuntimeState()).toEqual({});
    expect(genericRuntimeStateAdapter.createInitialState()).toEqual({});
    expect(genericRuntimeStateAdapter.merge({ value: 1 }, { value: 2 })).toEqual({ value: 2 });
  });
});
