import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AiTask, TaskStatusSnapshot } from '@inkpi/protocol';
import { InkRpcClient, SqliteTaskCheckpointStore, SqliteTaskExecutionStore } from '@inkpi/server';
import { InkDb } from '@inkpi/storage';
import { afterEach, describe, expect, it } from 'vitest';

type ChildEvent = { type: string; [key: string]: unknown };

interface RunningDaemon {
  child: ChildProcess;
  port: number;
  waitFor(type: string, timeoutMs?: number): Promise<ChildEvent>;
  stderr(): string;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

const repositoryRoot = resolve(__dirname, '..');
const temporaryDirectories = new Set<string>();
const activeDaemons = new Set<RunningDaemon>();

const CHILD_SCRIPT = String.raw`
import { InkPiDaemon, SqliteTaskCheckpointStore, SqliteTaskExecutionStore } from '@inkpi/server';
import { InkDb } from '@inkpi/storage';

const taskId = 'process-restart-e2e-task';
const taskKind = 'e2e.process-restart-faux';
const dbPath = process.env.INKPI_PROCESS_RESTART_DB;
if (!dbPath) throw new Error('INKPI_PROCESS_RESTART_DB is required');

const db = new InkDb(dbPath);
const checkpointStore = new SqliteTaskCheckpointStore(db);
const executionStore = new SqliteTaskExecutionStore(db);
const daemon = new InkPiDaemon({
  host: '127.0.0.1',
  context: { checkpointStore, executionStore }
});

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');

async function waitForDurableCheckpoint() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = db.prepare('SELECT snapshot_json FROM task_executions WHERE task_id = ?').get(taskId);
    if (row && typeof row.snapshot_json === 'string') {
      const snapshot = JSON.parse(row.snapshot_json);
      if (snapshot.checkpoint?.step === 'durable-step') return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('task execution checkpoint was not durable before the crash marker');
}

daemon.getTaskRouter().registry.register({
  id: 'local-faux-process-restart-handler',
  kinds: [taskKind],
  async execute({ checkpoint, saveCheckpoint, signal }) {
    if (checkpoint) {
      emit({ type: 'handler-resumed', taskId, step: checkpoint.step, data: checkpoint.data });
      return {
        output: {
          format: 'structured',
          data: { source: 'local-faux', resumedFrom: checkpoint.data }
        }
      };
    }

    await saveCheckpoint('durable-step', { marker: 'saved-before-crash', next: 'resume' });
    await waitForDurableCheckpoint();
    emit({ type: 'checkpoint-ready', taskId });

    await new Promise((_, reject) => {
      const onAbort = () => reject(new Error('unexpected graceful abort in crash phase'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    throw new Error('crash-phase handler should only finish after the OS terminates this process');
  }
});

await daemon.start(0, '127.0.0.1');
await daemon.getTaskRouter().ready;
emit({ type: 'ready', port: daemon.getStatus().port });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await daemon.stop();
    db.close();
  } finally {
    process.exit(0);
  }
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
setInterval(() => undefined, 1_000);
`;

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function startDaemon(dbPath: string): Promise<RunningDaemon> {
  const childEnv = { ...process.env };
  for (const key of [
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'GEMINI_API_KEY',
    'INKPI_MODEL_PRESET'
  ]) {
    delete childEnv[key];
  }
  childEnv.INKPI_PROCESS_RESTART_DB = dbPath;

  const child = spawn(process.execPath, ['--input-type=module', '--eval', CHILD_SCRIPT], {
    cwd: repositoryRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';
  const bufferedEvents: ChildEvent[] = [];
  const waiters = new Map<
    string,
    Array<{
      resolve: (event: ChildEvent) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>
  >();

  const childFailure = (reason: string): Error =>
    new Error(`Child daemon ${reason}; stderr=${stderrBuffer}; stdout=${stdoutBuffer}`);

  const rejectWaiters = (error: Error): void => {
    for (const entries of waiters.values()) {
      for (const waiter of entries) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    waiters.clear();
  };

  const publish = (event: ChildEvent): void => {
    const entries = waiters.get(event.type);
    const waiter = entries?.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      if (entries?.length === 0) waiters.delete(event.type);
      return;
    }
    bufferedEvents.push(event);
  };

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          const event = JSON.parse(line) as ChildEvent;
          if (event && typeof event.type === 'string') publish(event);
        } catch {
          // The child protocol is line-delimited JSON; retain malformed output in the diagnostic buffer.
        }
      }
      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderrBuffer += chunk;
  });
  child.on('error', (error) => rejectWaiters(childFailure(`failed to spawn: ${error.message}`)));
  child.on('exit', (code, signal) => {
    if (waiters.size > 0) {
      rejectWaiters(childFailure(`exited before an awaited event (code=${code}, signal=${signal})`));
    }
  });

  const running: RunningDaemon = {
    child,
    port: 0,
    stderr: () => stderrBuffer,
    waitFor: (type, timeoutMs = 15_000) => {
      const bufferedIndex = bufferedEvents.findIndex((event) => event.type === type);
      if (bufferedIndex !== -1) {
        return Promise.resolve(bufferedEvents.splice(bufferedIndex, 1)[0]);
      }
      if (hasExited(child)) {
        return Promise.reject(childFailure(`already exited while waiting for ${type}`));
      }
      return new Promise<ChildEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          const entries = waiters.get(type);
          const index = entries?.findIndex((entry) => entry.resolve === resolve);
          if (entries && index !== undefined && index !== -1) entries.splice(index, 1);
          reject(childFailure(`timed out waiting for ${type}`));
        }, timeoutMs);
        const entries = waiters.get(type) ?? [];
        entries.push({ resolve, reject, timer });
        waiters.set(type, entries);
      });
    }
  };
  activeDaemons.add(running);

  return running.waitFor('ready').then((event) => {
    if (typeof event.port !== 'number' || event.port <= 0) {
      throw childFailure('reported an invalid TCP port');
    }
    running.port = event.port;
    return running;
  });
}

function waitForChildExit(child: ChildProcess, timeoutMs = 10_000): Promise<ChildExit> {
  if (hasExited(child)) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise<ChildExit>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('Timed out waiting for child daemon exit'));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once('exit', onExit);
  });
}

async function terminateDaemon(running: RunningDaemon): Promise<void> {
  if (!hasExited(running.child)) {
    running.child.kill('SIGTERM');
    try {
      await waitForChildExit(running.child, 5_000);
    } catch {
      if (!hasExited(running.child)) running.child.kill('SIGKILL');
      try {
        await waitForChildExit(running.child, 5_000);
      } catch {
        // The process is no longer addressable; test cleanup has made the best bounded effort.
      }
    }
  }
  activeDaemons.delete(running);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(
  client: InkRpcClient,
  taskId: string,
  predicate: (snapshot: TaskStatusSnapshot) => boolean,
  timeoutMs = 15_000
): Promise<TaskStatusSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: TaskStatusSnapshot | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      lastSnapshot = await client.getTaskStatus(taskId);
      if (predicate(lastSnapshot)) return lastSnapshot;
    } catch (error) {
      lastError = error;
    }
    await delay(25);
  }
  const diagnostic = lastSnapshot ? JSON.stringify(lastSnapshot) : String(lastError);
  throw new Error(`Timed out waiting for task ${taskId}; last=${diagnostic}`);
}

afterEach(async () => {
  for (const daemon of [...activeDaemons]) await terminateDaemon(daemon);
  for (const directory of [...temporaryDirectories]) {
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

describe('real OS process crash and restart recovery', () => {
  it('recovers a durable task checkpoint through daemon RPC after SIGKILL and restart', async () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'inkpi-process-restart-'));
    temporaryDirectories.add(temporaryDirectory);
    const dbPath = join(temporaryDirectory, 'runtime.sqlite');
    const task = {
      id: 'process-restart-e2e-task',
      kind: 'e2e.process-restart-faux',
      input: { text: 'offline local faux input' },
      executionPolicy: {
        strategy: 'workflow',
        mode: 'background',
        checkpoint: { enabled: true, step: 'durable-step' }
      },
      outputContract: { format: 'structured' }
    } satisfies AiTask;

    let firstDaemon: RunningDaemon | undefined;
    let secondDaemon: RunningDaemon | undefined;
    let firstClient: InkRpcClient | undefined;
    let secondClient: InkRpcClient | undefined;
    try {
      firstDaemon = await startDaemon(dbPath);
      firstClient = await InkRpcClient.connectTcp(firstDaemon.port, '127.0.0.1');
      await expect(firstClient.request<{ running: boolean }>('daemon.status')).resolves.toMatchObject({
        running: true
      });
      await expect(firstClient.submitTask(task)).resolves.toMatchObject({ taskId: task.id, status: 'queued' });

      await expect(firstDaemon.waitFor('checkpoint-ready')).resolves.toMatchObject({
        type: 'checkpoint-ready',
        taskId: task.id
      });
      await expect(
        waitForStatus(firstClient, task.id, (snapshot) => snapshot.checkpoint?.step === 'durable-step')
      ).resolves.toMatchObject({ taskId: task.id, checkpoint: { step: 'durable-step' } });

      await firstClient.close();
      firstClient = undefined;
      expect(firstDaemon.child.kill('SIGKILL')).toBe(true);
      const crashExit = await waitForChildExit(firstDaemon.child);
      expect(crashExit.code).not.toBe(0);
      activeDaemons.delete(firstDaemon);
      firstDaemon = undefined;

      expect(existsSync(dbPath)).toBe(true);
      expect(statSync(dbPath).size).toBeGreaterThan(0);
      const evidenceDb = new InkDb(dbPath);
      try {
        const execution = new SqliteTaskExecutionStore(evidenceDb).load(task.id);
        expect(execution?.task).toEqual(task);
        expect(['running', 'checkpointed']).toContain(execution?.snapshot.status);
        expect(execution?.snapshot.checkpoint).toMatchObject({ step: 'durable-step', updatedAt: expect.any(Number) });
        expect(new SqliteTaskCheckpointStore(evidenceDb).load(task.id)).toMatchObject({
          taskId: task.id,
          kind: task.kind,
          step: 'durable-step',
          data: { marker: 'saved-before-crash', next: 'resume' }
        });
      } finally {
        evidenceDb.close();
      }

      secondDaemon = await startDaemon(dbPath);
      secondClient = await InkRpcClient.connectTcp(secondDaemon.port, '127.0.0.1');
      const interrupted = await waitForStatus(
        secondClient,
        task.id,
        (snapshot) => snapshot.status === 'interrupted' && snapshot.checkpoint?.step === 'durable-step'
      );
      expect(interrupted.error).toMatchObject({ code: 'TASK_INTERRUPTED' });
      expect(interrupted.checkpoint).toMatchObject({ step: 'durable-step' });

      await expect(secondClient.resumeTask(task.id)).resolves.toMatchObject({ taskId: task.id, status: 'queued' });
      await expect(secondDaemon.waitFor('handler-resumed')).resolves.toMatchObject({
        type: 'handler-resumed',
        taskId: task.id,
        step: 'durable-step',
        data: { marker: 'saved-before-crash', next: 'resume' }
      });
      const completed = await waitForStatus(
        secondClient,
        task.id,
        (snapshot) => snapshot.status === 'completed' && snapshot.result?.status === 'completed'
      );
      expect(completed.result).toMatchObject({
        taskId: task.id,
        status: 'completed',
        output: {
          format: 'structured',
          data: {
            source: 'local-faux',
            resumedFrom: { marker: 'saved-before-crash', next: 'resume' }
          }
        }
      });

      await secondClient.close();
      secondClient = undefined;
      await terminateDaemon(secondDaemon);
      secondDaemon = undefined;

      const finalDb = new InkDb(dbPath);
      try {
        expect(new SqliteTaskExecutionStore(finalDb).load(task.id)?.snapshot.status).toBe('completed');
        expect(new SqliteTaskCheckpointStore(finalDb).load(task.id)).toBeUndefined();
      } finally {
        finalDb.close();
      }
    } finally {
      if (firstClient) await firstClient.close().catch(() => undefined);
      if (secondClient) await secondClient.close().catch(() => undefined);
      if (firstDaemon) await terminateDaemon(firstDaemon);
      if (secondDaemon) await terminateDaemon(secondDaemon);
    }
  }, 30_000);
});
