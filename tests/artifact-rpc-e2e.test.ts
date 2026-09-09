import type { Artifact } from '@inkpi/protocol';
import { InkRpcClient } from '@inkpi/client';
import { InkPiDaemon } from '@inkpi/server';
import { InkDb, SqliteArtifactStore } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

describe('artifact RPC over TCP', () => {
  it('persists, reads, and filters artifacts through the real daemon transport', async () => {
    const db = new InkDb();
    const daemon = new InkPiDaemon({
      host: '127.0.0.1',
      context: { artifactStore: new SqliteArtifactStore(db) }
    });
    let client: InkRpcClient | undefined;
    const artifact: Artifact = {
      id: 'artifact:tcp-e2e',
      type: 'creative.chapter-summary',
      version: 1,
      content: { summary: 'TCP durable artifact' },
      provenance: { taskId: 'task:tcp-e2e', executionRunId: 'run:tcp-e2e' },
      createdAt: 10,
      updatedAt: 10
    };

    try {
      await daemon.start(0, '127.0.0.1');
      client = await InkRpcClient.connectTcp(daemon.getStatus().port!, '127.0.0.1');

      await expect(client.saveArtifact(artifact)).resolves.toEqual({ saved: true, id: artifact.id });
      await expect(client.getArtifact(artifact.id)).resolves.toEqual(artifact);
      await expect(client.listArtifacts({ taskId: 'task:tcp-e2e' })).resolves.toEqual([artifact]);
      await expect(client.listArtifacts({ type: artifact.type })).resolves.toEqual([artifact]);
    } finally {
      await client?.close();
      await daemon.stop();
      db.close();
    }
  });
});
