import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Artifact } from '@inkpi/protocol';
import { InkRpcClient } from '@inkpi/client';
import { createDaemonPersistence, InkPiDaemon } from '@inkpi/server';
import { InkDb, SqliteArtifactStore } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

async function connectTcp(daemon: InkPiDaemon): Promise<InkRpcClient> {
  await daemon.start(0, '127.0.0.1');
  return InkRpcClient.connectTcp(daemon.getStatus().port!, '127.0.0.1');
}

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
    const sameTypeOtherTask: Artifact = {
      ...artifact,
      id: 'artifact:tcp-e2e-other-task',
      provenance: { taskId: 'task:other' }
    };

    try {
      client = await connectTcp(daemon);

      await expect(client.saveArtifact(artifact)).resolves.toEqual({ saved: true, id: artifact.id });
      await expect(client.saveArtifact(sameTypeOtherTask)).resolves.toEqual({
        saved: true,
        id: sameTypeOtherTask.id
      });
      const rehydrated = await client.getArtifact(artifact.id);
      expect(rehydrated).toEqual(artifact);
      expect(JSON.parse(JSON.stringify(rehydrated))).toEqual(artifact);
      await expect(client.listArtifacts({ taskId: 'task:tcp-e2e' })).resolves.toEqual([artifact]);
      await expect(client.listArtifacts({ type: artifact.type })).resolves.toEqual([artifact, sameTypeOtherTask]);
      await expect(
        client.listArtifacts({ taskId: 'task:tcp-e2e', type: artifact.type })
      ).resolves.toEqual([artifact]);
    } finally {
      await client?.close();
      await daemon.stop();
      db.close();
    }
  });

  it('rehydrates artifacts after reopening the SQLite daemon context over TCP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkpi-artifact-rpc-rehydrate-'));
    const dbPath = join(root, 'state.sqlite');
    const artifact: Artifact = {
      id: 'artifact:tcp-rehydrated',
      type: 'creative.distillation-checkpoint',
      version: 2,
      content: {
        checkpoint: 'chunk-2',
        nested: { values: ['保留', '结构'] }
      },
      provenance: {
        taskId: 'task:rehydrate',
        executionRunId: 'run:rehydrate',
        parentArtifactId: 'artifact:parent'
      },
      createdAt: 20,
      updatedAt: 21
    };

    const firstPersistence = createDaemonPersistence({ dbPath });
    const firstDaemon = new InkPiDaemon({ context: firstPersistence.context });
    let firstClient: InkRpcClient | undefined;
    try {
      firstClient = await connectTcp(firstDaemon);
      await expect(firstClient.saveArtifact(artifact)).resolves.toEqual({ saved: true, id: artifact.id });
    } finally {
      await firstClient?.close();
      await firstDaemon.stop();
      firstPersistence.close();
    }

    const secondPersistence = createDaemonPersistence({ dbPath });
    const secondDaemon = new InkPiDaemon({ context: secondPersistence.context });
    let secondClient: InkRpcClient | undefined;
    try {
      secondClient = await connectTcp(secondDaemon);
      const rehydrated = await secondClient.getArtifact(artifact.id);
      expect(rehydrated).toEqual(artifact);
      expect(JSON.parse(JSON.stringify(rehydrated))).toEqual(artifact);
      await expect(secondClient.listArtifacts({ taskId: 'task:rehydrate' })).resolves.toEqual([artifact]);
      await expect(
        secondClient.listArtifacts({ taskId: 'task:rehydrate', type: artifact.type })
      ).resolves.toEqual([artifact]);
    } finally {
      await secondClient?.close();
      await secondDaemon.stop();
      secondPersistence.close();
    }
  });
});
