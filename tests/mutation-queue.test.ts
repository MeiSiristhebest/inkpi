import { describe, it, expect } from 'vitest';
import { InkDb, DocumentMutationQueue } from '@inkpi/storage';

describe('@inkpi/storage -> DocumentMutationQueue & Concurrency Leases', () => {
  it('should serialize concurrent mutations to the same document and execute atomically', async () => {
    const db = new InkDb(':memory:');
    const queue = new DocumentMutationQueue(db);

    const executionOrder: number[] = [];

    const p1 = queue.enqueue('ch_101', 'agent_writer_1', async () => {
      await new Promise((res) => setTimeout(res, 20));
      executionOrder.push(1);
      return 'ch1_res1';
    });

    const p2 = queue.enqueue('ch_101', 'agent_polisher_2', async () => {
      executionOrder.push(2);
      return 'ch1_res2';
    });

    const p3 = queue.enqueue('ch_202', 'agent_writer_3', async () => {
      executionOrder.push(3);
      return 'ch2_res3';
    });

    const results = await Promise.all([p1, p2, p3]);

    expect(results).toEqual(['ch1_res1', 'ch1_res2', 'ch2_res3']);
    // For ch_101, task 1 must finish before task 2 starts
    expect(executionOrder.indexOf(1)).toBeLessThan(executionOrder.indexOf(2));
    expect(queue.isDocumentBusy('ch_101')).toBe(false);
    expect(queue.getPendingCount()).toBe(0);
    expect(queue.getPendingCount('ch_101')).toBe(0);
    expect(queue.getLeaseManager()).toBeDefined();

    db.close();
  });


  it('should handle mutation errors gracefully without deadlocking subsequent tasks', async () => {
    const db = new InkDb(':memory:');
    const queue = new DocumentMutationQueue(db);

    const pFail = queue.enqueue('ch_999', 'agent_err', async () => {
      throw new Error('Database disk error');
    });

    const pSuccess = queue.enqueue('ch_999', 'agent_ok', async () => {
      return 'recovered';
    });

    await expect(pFail).rejects.toThrow('Database disk error');
    const successRes = await pSuccess;
    expect(successRes).toBe('recovered');

    db.close();
  });
});
