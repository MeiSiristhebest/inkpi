import type { ToolExecutionMode } from '@inkpi/protocol';

/** 并发策略。与 `ToolExecutionMode` 同构，便于两处共用同一实现。 */
export type ConcurrencyMode = ToolExecutionMode;

/**
 * 按给定并发策略对一组条目执行同一个异步操作，并保持输入顺序返回结果。
 *
 * 全仓库唯一的"顺序/并行"调度实现：`runAgentLoop` 的工具派发与
 * `ToolRegistry.executeBatch` 原本各有一份等价逻辑，现统一收敛到此处。
 *
 * - `sequential`：逐个 await，前一个结束才启动下一个；
 * - `parallel`：一次性启动全部，用 `Promise.all` 汇聚。
 */
export async function runWithConcurrency<TItem, TResult>(
  items: TItem[],
  execute: (item: TItem) => Promise<TResult>,
  mode: ConcurrencyMode = 'parallel'
): Promise<TResult[]> {
  if (mode === 'sequential') {
    const results: TResult[] = [];
    for (const item of items) {
      results.push(await execute(item));
    }
    return results;
  }

  return Promise.all(items.map((item) => execute(item)));
}
