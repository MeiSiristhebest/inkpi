import { describe, it, expect } from 'vitest';
import { runWithConcurrency } from '../packages/agent-core/src/concurrency.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('runWithConcurrency', () => {
  it('sequential 模式逐个执行，并保留输入顺序的结果', async () => {
    const order: string[] = [];
    const results = await runWithConcurrency(
      [
        { id: 'a', ms: 30 },
        { id: 'b', ms: 10 },
        { id: 'c', ms: 20 }
      ],
      async (item) => {
        order.push(`start:${item.id}`);
        await delay(item.ms);
        order.push(`end:${item.id}`);
        return item.id.toUpperCase();
      },
      'sequential'
    );

    expect(results).toEqual(['A', 'B', 'C']);
    // 顺序执行：每个 start 紧接自己的 end，不会交错
    expect(order).toEqual([
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c'
    ]);
  });

  it('parallel 模式全部并发启动，结果顺序仍与输入一致', async () => {
    let running = 0;
    let maxConcurrent = 0;

    const results = await runWithConcurrency(
      [50, 10, 30, 20],
      async (ms) => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await delay(ms);
        running -= 1;
        return ms;
      },
      'parallel'
    );

    expect(results).toEqual([50, 10, 30, 20]);
    expect(maxConcurrent).toBe(4);
  });

  it('默认模式为 parallel', async () => {
    let running = 0;
    let maxConcurrent = 0;
    await runWithConcurrency([20, 20], async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await delay(10);
      running -= 1;
      return 1;
    });
    expect(maxConcurrent).toBe(2);
  });

  it('空输入返回空数组且不调用执行器', async () => {
    let calls = 0;
    const results = await runWithConcurrency([] as number[], async (n) => {
      calls += 1;
      return n;
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it('任一任务抛错时向上冒泡（parallel 走 Promise.all 语义）', async () => {
    await expect(
      runWithConcurrency([1, 2], async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      })
    ).rejects.toThrow('boom');
  });

  it('sequential 模式下前序任务抛错则后续不再执行', async () => {
    const seen: number[] = [];
    await expect(
      runWithConcurrency([1, 2, 3], async (n) => {
        seen.push(n);
        if (n === 2) throw new Error('stop');
        return n;
      }, 'sequential')
    ).rejects.toThrow('stop');
    expect(seen).toEqual([1, 2]);
  });
});
