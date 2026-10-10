import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  type DirectoryCursor,
  type ExecutionEnv,
  type ProcessProgress,
  type ProcessRunRequest,
  type ProcessRunResult,
  RetainedOutputWindow,
  type TextReadRequest,
  type TextReadResult
} from '@inkpi/agent-core';
import { awaitWithAbort } from '@inkpi/protocol';

export interface NodeExecutionEnvOptions {
  root: string;
  allowWrite?: boolean;
  executables?: Readonly<Record<string, string>>;
  /** Environment variables are granted by the host, never read from tool arguments. */
  environment?: Readonly<Record<string, string>>;
  maxReadBytes?: number;
  maxScanBytes?: number;
  maxWriteBytes?: number;
  maxOutputCharacters?: number;
  progressIntervalMs?: number;
}

export class NodeExecutionEnv implements ExecutionEnv {
  readonly capabilities: ExecutionEnv['capabilities'];
  private readonly options: NodeExecutionEnvOptions;
  private readonly root: Promise<string>;
  private readonly mutations = new Map<string, Promise<unknown>>();
  private mutationAdmissions: Promise<unknown> = Promise.resolve();

  constructor(options: NodeExecutionEnvOptions) {
    this.options = {
      ...options,
      executables: { ...options.executables },
      environment: { ...options.environment },
      maxReadBytes: options.maxReadBytes ?? 32_000,
      maxScanBytes: options.maxScanBytes ?? 16 * 1024 * 1024,
      maxWriteBytes: options.maxWriteBytes ?? 2 * 1024 * 1024,
      maxOutputCharacters: options.maxOutputCharacters ?? 32_000,
      progressIntervalMs: options.progressIntervalMs ?? 250
    };
    for (const key of [
      'maxReadBytes',
      'maxScanBytes',
      'maxWriteBytes',
      'maxOutputCharacters',
      'progressIntervalMs'
    ] as const)
      positive(this.options[key]!, key);
    for (const executable of Object.values(this.options.executables!)) {
      if (!path.isAbsolute(executable)) throw new Error('Granted executable paths must be absolute.');
    }
    this.root = fs.realpath(path.resolve(options.root));
    // Keep root resolution lazy for callers; an invalid root still rejects every operation.
    void this.root.catch(() => undefined);
    this.capabilities = {
      write: options.allowWrite === true,
      process: Object.keys(options.executables ?? {}).length > 0
    };
  }

  private async resolve(input: string, create = false): Promise<string> {
    if (typeof input !== 'string' || !input || input.includes('\0')) throw new Error('Invalid environment path.');
    const root = await this.root;
    const candidate = path.resolve(root, input);
    assertInside(root, candidate);
    let resolved: string;
    try {
      resolved = await fs.realpath(candidate);
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      resolved = path.join(await fs.realpath(path.dirname(candidate)), path.basename(candidate));
    }
    assertInside(root, resolved);
    return resolved;
  }

  async readText(input: string, request: TextReadRequest = {}, signal?: AbortSignal): Promise<TextReadResult> {
    signal?.throwIfAborted();
    const startLine = positive(request.startLine ?? 1, 'startLine');
    const maxLines = positive(request.maxLines ?? 200, 'maxLines');
    const maxBytes = positive(request.maxBytes ?? this.options.maxReadBytes!, 'maxBytes');
    if (maxBytes > this.options.maxReadBytes! || maxLines > 10_000)
      throw new Error('Read request exceeds the host budget.');
    const file = await fs.open(await this.resolve(input), 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('readText requires a regular file.');
      const snapshotBytes = stat.size;
      const scanBudget = Math.min(snapshotBytes, this.options.maxScanBytes!);
      const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, scanBudget)));
      const decoder = new TextDecoder('utf-8');
      let scannedBytes = 0;
      let retainedBytes = 0;
      let line = 1;
      let text = '';
      let stopped = false;
      let discardedCharacters = false;
      let byteLimited = false;
      const consume = (chunk: string): void => {
        let consumed = 0;
        for (const character of chunk) {
          consumed += character.length;
          if (line >= startLine && line < startLine + maxLines) {
            const bytes = Buffer.byteLength(character);
            if (retainedBytes + bytes > maxBytes) {
              stopped = true;
              byteLimited = true;
              discardedCharacters = true;
              return;
            }
            text += character;
            retainedBytes += bytes;
          }
          if (character === '\n') {
            line++;
            if (line >= startLine + maxLines) {
              stopped = true;
              discardedCharacters = consumed < chunk.length;
              return;
            }
          }
        }
      };
      while (scannedBytes < scanBudget && !stopped) {
        signal?.throwIfAborted();
        const read = await file.read(buffer, 0, Math.min(buffer.length, scanBudget - scannedBytes), scannedBytes);
        signal?.throwIfAborted();
        if (!read.bytesRead) break;
        scannedBytes += read.bytesRead;
        consume(decoder.decode(buffer.subarray(0, read.bytesRead), { stream: true }));
      }
      if (!stopped && scannedBytes >= snapshotBytes) consume(decoder.decode());
      const scanLimitReached = scannedBytes >= this.options.maxScanBytes! && scannedBytes < snapshotBytes;
      const truncated = discardedCharacters || scannedBytes < snapshotBytes;
      return {
        text,
        snapshotBytes,
        scannedBytes,
        retainedBytes,
        skippedBytes: scannedBytes - retainedBytes,
        nextLine: truncated && !byteLimited && !scanLimitReached ? line : null,
        truncated,
        scanLimitReached
      };
    } finally {
      await file.close();
    }
  }

  async listDirectory(input: string, limit = 100, cursor?: DirectoryCursor, signal?: AbortSignal) {
    signal?.throwIfAborted();
    positive(limit, 'limit');
    if (limit > 200) throw new Error('Directory page exceeds the host budget.');
    const resolved = await this.resolve(input);
    const stat = await fs.stat(resolved);
    if (
      cursor &&
      (cursor.version !== 1 ||
        cursor.path !== resolved ||
        cursor.mtimeMs !== stat.mtimeMs ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0)
    )
      throw new Error('Stale or invalid directory cursor.');
    const offset = cursor?.offset ?? 0;
    if (offset > 100_000) throw new Error('Directory scan budget exceeded.');
    const entries: Array<{ name: string; kind: 'file' | 'directory' | 'symlink' | 'other' }> = [];
    let seen = 0;
    let hasMore = false;
    const directory = await fs.opendir(resolved);
    for await (const item of directory) {
      signal?.throwIfAborted();
      if (seen++ < offset) continue;
      if (entries.length === limit) {
        hasMore = true;
        break;
      }
      entries.push({
        name: item.name,
        kind: item.isFile() ? 'file' : item.isDirectory() ? 'directory' : item.isSymbolicLink() ? 'symlink' : 'other'
      });
    }
    if ((await fs.stat(resolved)).mtimeMs !== stat.mtimeMs) throw new Error('Directory changed during pagination.');
    return {
      entries,
      nextCursor: hasMore
        ? { version: 1 as const, path: resolved, offset: offset + entries.length, mtimeMs: stat.mtimeMs }
        : null
    };
  }

  private async mutate<T>(
    input: string,
    signal: AbortSignal | undefined,
    operation: (resolved: string) => Promise<T>
  ): Promise<T> {
    if (!this.capabilities.write) throw new Error('File writes are not granted by this environment.');
    // Only admission is serial: active mutations to different files remain independent.
    const admitted = this.mutationAdmissions
      .catch(() => undefined)
      .then(async () => {
        signal?.throwIfAborted();
        const resolved = await this.resolve(input, true);
        const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        const readiness = (this.mutations.get(key) ?? Promise.resolve()).catch(() => undefined);
        const state = { started: false };
        const pending = readiness.then(async () => {
          state.started = true;
          signal?.throwIfAborted();
          return operation(await this.resolve(input, true));
        });
        this.mutations.set(key, pending);
        void pending.catch(() => undefined);
        return { key, readiness, pending, state };
      });
    this.mutationAdmissions = admitted.then(
      () => undefined,
      () => undefined
    );
    const { key, readiness, pending, state } = await admitted;
    try {
      try {
        await awaitWithAbort(readiness, signal);
      } catch (error) {
        if (!state.started) throw error;
      }
      return await pending;
    } finally {
      // An aborted waiter does not remove the active mutation queue.
      void pending
        .finally(() => {
          if (this.mutations.get(key) === pending) this.mutations.delete(key);
        })
        .catch(() => undefined);
    }
  }

  private async replaceFile(resolved: string, text: string, signal?: AbortSignal): Promise<{ bytesWritten: number }> {
    if (Buffer.byteLength(text, 'utf8') > this.options.maxWriteBytes!)
      throw new Error('Write exceeds the host budget.');
    const bytes = Buffer.from(text, 'utf8');
    let mode: number | undefined;
    try {
      mode = (await fs.stat(resolved)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = path.join(path.dirname(resolved), `.inkpi-${randomUUID()}.tmp`);
    try {
      signal?.throwIfAborted();
      const file = await fs.open(temporary, 'wx', mode);
      try {
        if (mode !== undefined) await file.chmod(mode);
        await file.writeFile(bytes, { signal });
        await file.sync();
      } finally {
        await file.close();
      }
      signal?.throwIfAborted();
      await fs.rename(temporary, resolved);
      return { bytesWritten: bytes.length };
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async writeText(input: string, text: string, signal?: AbortSignal) {
    return this.mutate(input, signal, (resolved) => this.replaceFile(resolved, text, signal));
  }

  async editText(input: string, oldText: string, newText: string, signal?: AbortSignal) {
    if (!oldText) throw new Error('Edit match must not be empty.');
    if (Buffer.byteLength(newText, 'utf8') > this.options.maxWriteBytes!)
      throw new Error('Edit exceeds the host budget.');
    return this.mutate(input, signal, async (resolved) => {
      const file = await fs.open(resolved, 'r');
      let content: string;
      try {
        const size = (await file.stat()).size;
        if (size > this.options.maxWriteBytes!) throw new Error('Edit exceeds the host budget.');
        const bytes = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          signal?.throwIfAborted();
          const read = await file.read(bytes, offset, size - offset, offset);
          if (!read.bytesRead) throw new Error('File changed during edit.');
          offset += read.bytesRead;
        }
        if ((await file.stat()).size !== size) throw new Error('File changed during edit.');
        content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } finally {
        await file.close();
      }
      const index = content.indexOf(oldText);
      if (index < 0 || content.indexOf(oldText, index + 1) >= 0) throw new Error('Edit match must occur exactly once.');
      return this.replaceFile(
        resolved,
        content.slice(0, index) + newText + content.slice(index + oldText.length),
        signal
      );
    });
  }

  async runProcess(
    request: ProcessRunRequest,
    signal?: AbortSignal,
    onProgress?: (progress: ProcessProgress) => void
  ): Promise<ProcessRunResult> {
    signal?.throwIfAborted();
    const executable = this.options.executables?.[request.command];
    if (!executable || !Object.hasOwn(this.options.executables!, request.command))
      throw new Error('Executable is not granted by this environment.');
    if (!Array.isArray(request.args) || request.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
      throw new Error('Process arguments must be a string array.');
    const timeoutMs = positive(request.timeoutMs ?? 30_000, 'timeoutMs');
    if (timeoutMs > 120_000) throw new Error('Process timeout exceeds the host budget.');
    const cwd = await this.resolve(request.cwd ?? '.');
    const stdout = new RetainedOutputWindow(this.options.maxOutputCharacters);
    const stderr = new RetainedOutputWindow(this.options.maxOutputCharacters);
    const start = performance.now();
    let lastProgress = start;
    let termination: ProcessRunResult['termination'] = 'exited';
    const snapshot = () => ({ stdout: stdout.snapshot(), stderr: stderr.snapshot() });
    return new Promise((resolve, reject) => {
      const child = spawn(executable, [...request.args], {
        cwd,
        env: { ...this.options.environment },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let callbackError: unknown;
      const cancel = () => {
        termination = 'cancelled';
        child.kill('SIGKILL');
      };
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      const timeout = setTimeout(() => {
        termination = 'timeout';
        child.kill('SIGKILL');
      }, timeoutMs);
      const outDecoder = new StringDecoder('utf8');
      const errDecoder = new StringDecoder('utf8');
      const collect = (window: RetainedOutputWindow, decoder: StringDecoder, chunk: Buffer) => {
        window.append(decoder.write(chunk));
        if (onProgress && performance.now() - lastProgress >= this.options.progressIntervalMs!) {
          lastProgress = performance.now();
          try {
            onProgress(snapshot());
          } catch (error) {
            callbackError = error;
            child.kill('SIGKILL');
          }
        }
      };
      child.stdout.on('data', (chunk: Buffer) => collect(stdout, outDecoder, chunk));
      child.stderr.on('data', (chunk: Buffer) => collect(stderr, errDecoder, chunk));
      child.on('error', (error) => {
        callbackError = error;
      });
      child.on('close', (exitCode) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        stdout.append(outDecoder.end());
        stderr.append(errDecoder.end());
        if (callbackError) {
          reject(callbackError);
          return;
        }
        resolve({ ...snapshot(), exitCode, termination, durationMs: Math.max(0, performance.now() - start) });
      });
    });
  }
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error('Path is outside the execution root.');
}
