import { InkDb, WriterLeaseManager } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

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
    const acquiredBAfter = leases.acquire(leaseId, processB, 1000);
    expect(acquiredBAfter).toBe(true);

    expect(leases.getLease('non_existent')).toBeUndefined();
    expect(leases.isLockedByOther('non_existent', 'anyone')).toBe(false);
    expect(leases.release('non_existent', 'nobody')).toBe(false);

    db.close();
  });

  it('fences stale grants after a lease is released and reacquired', () => {
    const db = new InkDb(':memory:');
    const leases = new WriterLeaseManager(db, 1000);

    const grantA = leases.acquireLease('document_lock', 'writer-a');
    expect(grantA?.fencingToken).toBe(1);
    expect(grantA && leases.release('document_lock', 'writer-a', grantA.fencingToken)).toBe(true);

    const grantB = leases.acquireLease('document_lock', 'writer-b');
    expect(grantB?.fencingToken).toBe(2);
    expect(leases.renew('document_lock', 'writer-a', 1000, grantA?.fencingToken)).toBe(false);
    expect(leases.release('document_lock', 'writer-a', grantA?.fencingToken)).toBe(false);
    expect(leases.getLease('document_lock')).toMatchObject({
      holderId: 'writer-b',
      fencingToken: 2
    });

    db.close();
  });

  it('allows a new holder only after expiry and keeps fencing monotonic', () => {
    vi.useFakeTimers();
    try {
      const db = new InkDb(':memory:');
      const leases = new WriterLeaseManager(db, 100);
      const grantA = leases.acquireLease('expiring_lock', 'writer-a');

      expect(grantA?.fencingToken).toBe(1);
      expect(leases.acquireLease('expiring_lock', 'writer-b')).toBeUndefined();

      vi.advanceTimersByTime(101);
      expect(leases.isLockedByOther('expiring_lock', 'writer-b')).toBe(false);

      const grantB = leases.acquireLease('expiring_lock', 'writer-b');
      expect(grantB?.fencingToken).toBe(2);
      expect(leases.isLeaseActive('expiring_lock', 'writer-b', grantB!.fencingToken)).toBe(true);
      expect(leases.renew('expiring_lock', 'writer-a', 100, grantA!.fencingToken)).toBe(false);

      db.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
