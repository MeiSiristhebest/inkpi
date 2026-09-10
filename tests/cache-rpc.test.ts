import { RuntimeCacheCoordinator } from '@inkpi/agent-core';
import type { CacheStatus } from '@inkpi/protocol';
import { InkPiDaemon } from '@inkpi/server';
import { describe, expect, it } from 'vitest';

describe('Runtime cache lifecycle RPC', () => {
  it('exposes shared cache metrics and invalidates selected layers', async () => {
    const coordinator = new RuntimeCacheCoordinator();
    coordinator.record('provider', 'hit');
    coordinator.record('retrieval', 'miss');
    const daemon = new InkPiDaemon({ cacheCoordinator: coordinator });
    const rpc = daemon.getRpcServer();

    const before = await rpc.handleRequest({ jsonrpc: '2.0', id: 1, method: 'cache.status' });
    expect((before.result as CacheStatus).stats).toMatchObject({
      provider: { hits: 1 },
      retrieval: { misses: 1 }
    });

    const invalidated = await rpc.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'cache.invalidate',
      params: { reason: 'manual', layers: ['provider', 'retrieval'] }
    });
    expect(invalidated.result).toMatchObject({
      accepted: true,
      status: {
        version: 1,
        stats: {
          provider: { invalidations: 1 },
          context: { invalidations: 0 },
          retrieval: { invalidations: 1 }
        }
      }
    });
  });

  it('rejects malformed revision invalidation requests', async () => {
    const daemon = new InkPiDaemon();
    const response = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'cache.invalidate',
      params: { reason: 'revision' }
    });

    expect(response.error?.message).toContain('requires projectRevision');
  });
});
