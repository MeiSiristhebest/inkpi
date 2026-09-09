import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DomainProjectionStore,
  InkDb,
  ProposalProjectionStore,
  SqliteArtifactStore,
} from '@inkpi/storage';
import type { ServerContext } from './server.js';
import { SqliteTaskCheckpointStore } from './task-checkpoint-store.js';
import { SqliteTaskExecutionStore } from './task-execution-store.js';

export const DEFAULT_DAEMON_STATE_DB_FILENAME = 'state.sqlite';

export interface DaemonPersistenceOptions {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export type PersistentDaemonContext = Pick<
  ServerContext,
  'domainProjection' | 'proposalProjection' | 'artifactStore' | 'checkpointStore' | 'executionStore'
>;

export interface DaemonPersistence {
  readonly db: InkDb;
  readonly dbPath: string;
  readonly context: PersistentDaemonContext;
  close(): void;
}

/** Resolve the one SQLite state path used by a daemon process. */
export function resolveDaemonDbPath(options: DaemonPersistenceOptions = {}): string {
  const env = options.env ?? process.env;
  const explicitPath = nonEmpty(options.dbPath);
  if (explicitPath) return explicitPath;

  const environmentPath = nonEmpty(env.INKPI_STATE_DB);
  if (environmentPath) return environmentPath;

  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;
  const applicationDataRoot =
    platform === 'win32'
      ? nonEmpty(env.APPDATA) ?? nonEmpty(env.LOCALAPPDATA) ?? join(homeDir, 'AppData', 'Roaming')
      : platform === 'darwin'
        ? join(homeDir, 'Library', 'Application Support')
        : nonEmpty(env.XDG_DATA_HOME) ?? join(homeDir, '.local', 'share');

  return join(applicationDataRoot, 'inkpi', DEFAULT_DAEMON_STATE_DB_FILENAME);
}

/**
 * Create the SQLite-backed context shared by the daemon's durable runtime
 * paths. The caller owns the returned database lifecycle and must call close.
 */
export function createDaemonPersistence(options: DaemonPersistenceOptions = {}): DaemonPersistence {
  const dbPath = resolveDaemonDbPath(options);
  ensureParentDirectory(dbPath);
  const db = new InkDb(dbPath);
  let closed = false;

  return {
    db,
    dbPath,
    context: {
      domainProjection: new DomainProjectionStore(db),
      proposalProjection: new ProposalProjectionStore(db),
      artifactStore: new SqliteArtifactStore(db),
      checkpointStore: new SqliteTaskCheckpointStore(db),
      executionStore: new SqliteTaskExecutionStore(db),
    },
    close: () => {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

function ensureParentDirectory(dbPath: string): void {
  if (dbPath === ':memory:') return;
  mkdirSync(dirname(dbPath), { recursive: true });
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}
