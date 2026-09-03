import type { StateLedger } from '@inkpi/protocol';

/**
 * 构造一个全空的领域状态账本。
 *
 * 全仓库唯一定义：门禁检测、角色调用、工作流上下文初始化共用它，
 * 避免各处散落形状不一致的空账本字面量。
 */
export function emptyLedger(): StateLedger {
  return { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] };
}

/**
 * 合并两个领域状态账本。纯函数，无副作用，无 I/O。
 *
 * 原位于 `WorkflowCoordinator.mergeLedgers`（私有方法），现抽出为独立纯函数以便单测与复用。
 * 逻辑逐字搬运，行为不变：实体/资产按 `id|name` 归并，追踪项/地点按 `mergeRecords` 归并，
 * `includeLegacyAliases` 控制是否保留 `characters/items/foreshadowings/modifiedChapters/modifiedDocuments` 旧别名。
 */
export function mergeLedgers(
  base: StateLedger,
  addition: Partial<StateLedger>,
  includeLegacyAliases = false
): StateLedger {
  const baseEntities = base.entities || base.characters || [];
  const addEntities = addition.entities || addition.characters || [];
  const charMap = new Map<string, any>(baseEntities.map((c: any, index) => [c.id || c.name || `entity-${index}`, c]));
  for (const c of addEntities) {
    const key = c.id || c.name || `entity-${charMap.size}`;
    const existing = charMap.get(key);
    charMap.set(key, existing ? { ...existing, ...c } : { ...c });
  }

  const baseAssets = base.assets || base.items || [];
  const addAssets = addition.assets || addition.items || [];
  const itemMap = new Map<string, any>(baseAssets.map((i: any, index) => [i.id || i.name || `asset-${index}`, i]));
  for (const item of addAssets) {
    const key = item.id || item.name || `asset-${itemMap.size}`;
    const existing = itemMap.get(key);
    itemMap.set(key, existing ? { ...existing, ...item } : { ...item });
  }

  const chapters = new Set([
    ...(base.modifiedResources || base.modifiedChapters || base.modifiedDocuments || []),
    ...(addition.modifiedResources || addition.modifiedChapters || addition.modifiedDocuments || [])
  ]);

  const characters = Array.from(charMap.values());
  const items = Array.from(itemMap.values());
  const tracks = mergeRecords(
    base.tracks || [],
    addition.tracks || [],
    (track: any, index) => track.id || track.clue || track.summary || `track-${index}`
  );
  const locations = mergeRecords(
    base.locations || [],
    addition.locations || [],
    (location: any, index) => location.id || location.name || `location-${index}`
  );

  const result: StateLedger = {
    ...base,
    ...addition,
    locations,
    entities: characters,
    assets: items,
    tracks,
    modifiedResources: Array.from(chapters)
  } as StateLedger;

  if (!includeLegacyAliases) {
    // biome-ignore lint/performance/noDelete: 需从合并结果移除旧结构带来的兼容键；=undefined 会保留键（测试断言 not.toHaveProperty）
    delete (result as any).characters;
    // biome-ignore lint/performance/noDelete: 同上，剔除旧字段键
    delete (result as any).items;
    // biome-ignore lint/performance/noDelete: 同上，剔除旧字段键
    delete (result as any).foreshadowings;
    // biome-ignore lint/performance/noDelete: 同上，剔除旧字段键
    delete (result as any).modifiedChapters;
    // biome-ignore lint/performance/noDelete: 同上，剔除旧字段键
    delete (result as any).modifiedDocuments;
    return result;
  }

  Object.assign(result, {
    characters,
    items,
    foreshadowings: tracks,
    modifiedChapters: Array.from(chapters),
    modifiedDocuments: Array.from(chapters)
  });
  return result;
}

/**
 * 按 `keyOf` 归并两条记录数组：相同 key 的后项浅覆盖前项。纯函数。
 */
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
