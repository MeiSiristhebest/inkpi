import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Artifact } from '@inkpi/protocol';
import {
  FileRuntimeCachePersistence,
  InMemoryTransport,
  InkPiDaemon,
  InkRpcClient,
  SqliteTaskCheckpointStore,
  SqliteTaskExecutionStore,
  SqliteTaskSchedulerPersistence,
  createDaemonPersistence,
  resolveDaemonDbPath
} from '@inkpi/server';
import { DomainProjectionStore, ProposalProjectionStore, SqliteArtifactStore } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

describe('daemon persistent SQLite context', () => {
  it('uses explicit and environment paths before the OS application data path', () => {
    const homeDir = join(mkdtempSync(join(tmpdir(), 'inkpi-persistence-home-')), 'home');
    const environmentPath = join(homeDir, 'from-env.sqlite');
    const explicitPath = join(homeDir, 'nested', 'from-argument.sqlite');

    expect(
      resolveDaemonDbPath({
        dbPath: explicitPath,
        env: { INKPI_STATE_DB: environmentPath },
        platform: 'linux',
        homeDir
      })
    ).toBe(explicitPath);
    expect(
      resolveDaemonDbPath({
        env: { INKPI_STATE_DB: environmentPath },
        platform: 'linux',
        homeDir
      })
    ).toBe(environmentPath);
    expect(resolveDaemonDbPath({ env: {}, platform: 'linux', homeDir })).toBe(
      join(homeDir, '.local', 'share', 'inkpi', 'state.sqlite')
    );
    expect(resolveDaemonDbPath({ env: { APPDATA: 'C:\\AppData' }, platform: 'win32', homeDir })).toBe(
      join('C:\\AppData', 'inkpi', 'state.sqlite')
    );
    expect(resolveDaemonDbPath({ env: {}, platform: 'darwin', homeDir })).toBe(
      join(homeDir, 'Library', 'Application Support', 'inkpi', 'state.sqlite')
    );
  });

  it('creates one SQLite context with all durable stores and creates parent directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'inkpi-persistence-context-'));
    const dbPath = join(root, 'created', 'deep', 'state.sqlite');
    const persistence = createDaemonPersistence({ dbPath });

    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(existsSync(dirname(dbPath))).toBe(true);
      expect(persistence.db.getPath()).toBe(dbPath);
      expect(persistence.context.domainProjection).toBeInstanceOf(DomainProjectionStore);
      expect(persistence.context.proposalProjection).toBeInstanceOf(ProposalProjectionStore);
      expect(persistence.context.artifactStore).toBeInstanceOf(SqliteArtifactStore);
      expect(persistence.context.checkpointStore).toBeInstanceOf(SqliteTaskCheckpointStore);
      expect(persistence.context.executionStore).toBeInstanceOf(SqliteTaskExecutionStore);
      expect(persistence.context.schedulerPersistence).toBeInstanceOf(SqliteTaskSchedulerPersistence);
      expect(persistence.context.jitRetriever).toBeDefined();
      expect(persistence.cachePersistence).toBeInstanceOf(FileRuntimeCachePersistence);
      expect(() => persistence.close()).not.toThrow();
      expect(() => persistence.close()).not.toThrow();
    } finally {
      persistence.close();
    }
  });

  it('wires the cache lifecycle into a production-shaped daemon context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkpi-persistence-cache-'));
    const dbPath = join(root, 'state.sqlite');
    const persistence = createDaemonPersistence({ dbPath });
    const daemon = new InkPiDaemon({
      context: persistence.context,
      cachePersistence: persistence.cachePersistence,
      defaultModel: {
        id: 'persistence-cache-model',
        name: 'Persistence cache model',
        provider: 'faux'
      }
    });

    try {
      await daemon.start(0, '127.0.0.1');
      await daemon.stop();
      expect(existsSync(`${dbPath}.cache.json`)).toBe(true);
    } finally {
      await daemon.stop();
      persistence.close();
    }
  });

  it('keeps artifacts available through a daemon context after reopening the DB', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inkpi-persistence-reopen-'));
    const dbPath = join(root, 'state.sqlite');
    const artifact: Artifact = {
      id: 'artifact:persistent-context',
      type: 'test.persistent-context',
      version: 1,
      content: { value: 'durable' },
      provenance: { taskId: 'task:persistent-context' },
      createdAt: 1,
      updatedAt: 1
    };

    const first = createDaemonPersistence({ dbPath });
    await first.context.artifactStore?.save(artifact);
    first.close();

    const second = createDaemonPersistence({ dbPath });
    const daemon = new InkPiDaemon({ context: second.context });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    try {
      await expect(client.getArtifact(artifact.id)).resolves.toEqual(artifact);
    } finally {
      await client.close();
      await daemon.stop();
      second.close();
    }
  });
});
