import { describe, it, expect } from 'vitest';
import { InkDb, WriterLeaseManager } from '@inkpi/storage';

describe('@inkpi/storage -> WriterLeaseManager (Multi-process Concurrency Safety, 1:1 Ported from repos/pi)', () => {
  it('should acquire, renew, release, and detect lease collisions across processes', () => {
    const db = new InkDb(':memory:');
    const leases = new WriterLeaseManager(db, 1000); // 1s TTL for testing

    const leaseId = 'workspace_lock_101';
    const processA = 'proc_window_a';
    const processB = 'proc_window_b';

    // 1. Process A acquires lease
    const acquiredA = leases.acquire(leaseId, processA, 1000, 'Window A active');
    expect(acquiredA).toBe(true);

    // 2. Process B attempts to acquire same lease -> must be rejected
    const acquiredB = leases.acquire(leaseId, processB, 1000, 'Window B active');
    expect(acquiredB).toBe(false);

    // 3. Collision check
    expect(leases.isLockedByOther(leaseId, processA)).toBe(false);
    expect(leases.isLockedByOther(leaseId, processB)).toBe(true);

    // 4. Process A renews lease
    const renewed = leases.renew(leaseId, processA, 2000);
    expect(renewed).toBe(true);

    // 5. Process B cannot renew Process A's lease
    const renewedFake = leases.renew(leaseId, processB, 2000);
    expect(renewedFake).toBe(false);

    // 6. Get lease info
    const info = leases.getLease(leaseId);
    expect(info?.holderId).toBe(processA);
    expect(info?.metadata).toBe('Window A active');

    // 7. Process A releases lease
    const released = leases.release(leaseId, processA);
    expect(released).toBe(true);

    // 8. Process B can now acquire the released lease
    const acquiredBAfter = leases.acquireLease(leaseId, processB, 1000);
    expect(acquiredBAfter).toBe(true);

    expect(leases.getLease('non_existent')).toBeUndefined();
    expect(leases.isLockedByOther('non_existent', 'anyone')).toBe(false);
    expect(leases.releaseLease('non_existent', 'nobody')).toBe(false);

    db.close();
  });
});
