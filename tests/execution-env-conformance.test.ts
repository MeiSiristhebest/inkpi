import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolRegistry, createDocumentResourceTools, createExecutionEnvTools } from '@inkpi/agent-core';
import { InkPiDaemon, NodeExecutionEnv } from '@inkpi/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  readLimit: Number.POSITIVE_INFINITY,
  afterRead: undefined as (() => Promise<void>) | undefined,
  renameGate: undefined as (() => Promise<void>) | undefined
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await actual.open(...args);
      const read = file.read.bind(file);
      file.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, Math.min(length, controls.readLimit), position);
        const afterRead = controls.afterRead;
        controls.afterRead = undefined;
        await afterRead?.();
        return result;
      }) as typeof file.read;
      return file;
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await controls.renameGate?.();
      return actual.rename(...args);
    }
  };
});

let dir: string;
let root: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkpi-env-'));
  root = path.join(dir, 'root');
  await fs.mkdir(root);
});
afterEach(async () => {
  controls.readLimit = Number.POSITIVE_INFINITY;
  controls.afterRead = undefined;
  controls.renameGate = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function environment(options: Partial<ConstructorParameters<typeof NodeExecutionEnv>[0]> = {}) {
  return new NodeExecutionEnv({ root, ...options });
}

describe('host-bound asynchronous execution environment', () => {
  it('decodes UTF-8 and BOM across short reads and returns only the requested lines', async () => {
    controls.readLimit = 2;
    await fs.writeFile(path.join(root, 'chapter.txt'), '\uFEFF第一行\r\n第二行🙂\n第三行');
    const result = await environment().readText('chapter.txt', { startLine: 2, maxLines: 1 });
    expect(result.text).toBe('第二行🙂\n');
    expect(result.text).not.toContain('�');
    expect(result.nextLine).toBe(3);
    expect(result.retainedBytes).toBe(Buffer.byteLength(result.text));
    expect(result.skippedBytes).toBe(result.scannedBytes - result.retainedBytes);
  });

  it('bounds huge single lines and counts skipped scan bytes without splitting a code point', async () => {
    await fs.writeFile(path.join(root, 'long.txt'), '中'.repeat(500_000));
    const result = await environment({ maxReadBytes: 100 }).readText('long.txt');
    expect(result.text).toBe('中'.repeat(33));
    expect(result.retainedBytes).toBe(99);
    expect(result.scannedBytes).toBeLessThanOrEqual(65536);
    expect(result.skippedBytes).toBe(result.scannedBytes - 99);
    expect(result.truncated).toBe(true);
    expect(result.nextLine).toBeNull();
    await expect(environment({ maxReadBytes: 100 }).readText('long.txt', { maxBytes: 101 })).rejects.toThrow(/budget/);
  });

  it('does not follow an actively growing file beyond its initial size', async () => {
    const file = path.join(root, 'growing.txt');
    await fs.writeFile(file, 'old\n');
    controls.readLimit = 2;
    controls.afterRead = async () => {
      await fs.appendFile(file, 'new\n'.repeat(10_000));
    };
    const result = await environment().readText('growing.txt');
    expect(result.text).toBe('old\n');
    expect(result.snapshotBytes).toBe(4);
    expect(result.scannedBytes).toBe(4);
    expect(result.truncated).toBe(false);
  });

  it('bounds scans for missing late lines and respects cancellation between reads', async () => {
    await fs.writeFile(path.join(root, 'scan.txt'), 'a'.repeat(100_000));
    const result = await environment({ maxScanBytes: 128 }).readText('scan.txt', { startLine: 100 });
    expect(result.text).toBe('');
    expect(result.scannedBytes).toBe(128);
    expect(result.scanLimitReached).toBe(true);
    const controller = new AbortController();
    controls.afterRead = async () => {
      controller.abort();
    };
    await expect(environment().readText('scan.txt', {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError'
    });
  });

  it('rejects traversal and directory links outside the host root for reads and writes', async () => {
    const outside = path.join(dir, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'private.txt'), 'unchanged');
    await fs.symlink(outside, path.join(root, 'link'), 'junction');
    const env = environment({ allowWrite: true });
    for (const name of ['../outside/private.txt', path.join(outside, 'private.txt'), 'link/private.txt']) {
      await expect(env.readText(name)).rejects.toThrow(/outside/);
      await expect(env.writeText(name, 'changed')).rejects.toThrow(/outside/);
    }
    expect(await fs.readFile(path.join(outside, 'private.txt'), 'utf8')).toBe('unchanged');
    await expect(environment().writeText('file', 'no grant')).rejects.toThrow(/not granted/);
  });

  it('pages directories without collecting all names and rejects changed or foreign cursors', async () => {
    for (let index = 0; index < 13; index++) await fs.writeFile(path.join(root, `chapter-${index}`), '');
    const env = environment();
    let page = await env.listDirectory('.', 3);
    const cursor = page.nextCursor!;
    const names = page.entries.map((entry) => entry.name);
    while (page.nextCursor) {
      page = await env.listDirectory('.', 3, page.nextCursor);
      names.push(...page.entries.map((entry) => entry.name));
    }
    expect(new Set(names).size).toBe(13);
    await fs.writeFile(path.join(root, 'new'), '');
    await expect(env.listDirectory('.', 3, cursor)).rejects.toThrow(/cursor/);
    await expect(env.listDirectory('.', 3, { ...cursor, path: 'other' })).rejects.toThrow(/cursor/);
  });

  it('serializes edits to the same file, keeps EOL and removes its temporary files', async () => {
    await fs.writeFile(path.join(root, 'chapter.txt'), '\uFEFFa\r\nend\r\n');
    const env = environment({ allowWrite: true });
    await Promise.all([env.editText('chapter.txt', 'a', 'b'), env.editText('chapter.txt', 'b', 'c')]);
    expect(await fs.readFile(path.join(root, 'chapter.txt'), 'utf8')).toBe('\uFEFFc\r\nend\r\n');
    await expect(env.editText('chapter.txt', 'missing', 'x')).rejects.toThrow(/exactly once/);
    expect(await fs.readdir(root)).toEqual(['chapter.txt']);
  });

  it('serializes canonical aliases and applies write size limits before any replacement', async () => {
    await fs.writeFile(path.join(root, 'file'), 'a');
    await fs.symlink(root, path.join(root, 'alias'), 'junction');
    const env = environment({ allowWrite: true, maxWriteBytes: 10 });
    await Promise.all([env.editText('file', 'a', 'b'), env.editText('alias/file', 'b', 'c')]);
    expect(await fs.readFile(path.join(root, 'file'), 'utf8')).toBe('c');
    const invalidUtf8 = Buffer.from([0xff, 0x61]);
    await fs.writeFile(path.join(root, 'binary'), invalidUtf8);
    await expect(env.editText('binary', 'a', 'b')).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'binary'))).toEqual(invalidUtf8);
    await expect(env.writeText('file', 'x'.repeat(11))).rejects.toThrow(/budget/);
    expect(await fs.readFile(path.join(root, 'file'), 'utf8')).toBe('c');
  });

  it('cancels a queued mutation without breaking the active owner or another file', async () => {
    const entered = deferred();
    const finish = deferred();
    const env = environment({ allowWrite: true });
    await fs.writeFile(path.join(root, 'file'), 'old');
    let first = true;
    controls.renameGate = async () => {
      if (first) {
        first = false;
        entered.release();
        await finish.promise;
      }
    };
    const active = env.writeText('file', 'first');
    await entered.promise;
    const controller = new AbortController();
    const cancelled = env.writeText('file', 'cancelled', controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await env.writeText('other', 'independent');
    finish.release();
    await active;
    await env.writeText('file', 'last');
    expect(await fs.readFile(path.join(root, 'file'), 'utf8')).toBe('last');
    expect((await fs.readdir(root)).sort()).toEqual(['file', 'other']);
  });

  it('runs argv literally in the granted cwd and passes only host-provided environment', async () => {
    await fs.mkdir(path.join(root, 'nested'));
    const env = environment({ executables: { node: process.execPath }, environment: { HOST_MARKER: 'granted' } });
    const values = ['a b', '; echo injected', '$HOME', '$(anything)', '中文🙂'];
    const result = await env.runProcess({
      command: 'node',
      cwd: 'nested',
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),marker:process.env.HOST_MARKER,home:process.env.HOME??null}))',
        '--',
        ...values
      ]
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.content)).toEqual({
      args: values,
      cwd: path.join(root, 'nested'),
      marker: 'granted',
      home: null
    });
    await expect(env.runProcess({ command: 'ungranted', args: [] })).rejects.toThrow(/not granted/);
    await expect(env.runProcess({ command: 'node', args: [], cwd: '..' })).rejects.toThrow(/outside/);
  });

  it('drains continuous output into a fixed window and reports exact discarded characters', async () => {
    const result = await environment({ executables: { node: process.execPath }, maxOutputCharacters: 256 }).runProcess({
      command: 'node',
      args: ['-e', "process.stdout.write('x'.repeat(1_000_000)+'中🙂'); process.stderr.write('e'.repeat(900));"]
    });
    expect(result.stdout.totalCharacters).toBe(1_000_003);
    expect(result.stdout.content.length).toBeLessThanOrEqual(256);
    expect(result.stdout.content.endsWith('中🙂')).toBe(true);
    expect(result.stdout.skippedCharacters).toBe(result.stdout.totalCharacters - result.stdout.content.length);
    expect(result.stderr.totalCharacters).toBe(900);
    expect(result.stderr.skippedCharacters).toBe(644);
  });

  it('kills and drains the actual child on cancellation and timeout', async () => {
    const env = environment({ executables: { node: process.execPath }, progressIntervalMs: 1 });
    const controller = new AbortController();
    const cancelled = await env.runProcess(
      {
        command: 'node',
        args: ['-e', "process.stdout.write(String(process.pid)); setInterval(()=>process.stdout.write('.'),10)"]
      },
      controller.signal,
      () => {
        controller.abort();
      }
    );
    expect(cancelled.termination).toBe('cancelled');
    const pid = Number.parseInt(cancelled.stdout.content, 10);
    expect(() => process.kill(pid, 0)).toThrow();
    const timed = await env.runProcess({ command: 'node', args: ['-e', 'while(true) {}'], timeoutMs: 30 });
    expect(timed.termination).toBe('timeout');
    expect(timed.durationMs).toBeGreaterThanOrEqual(25);
  });

  it('exposes only granted tools in the production daemon registry', async () => {
    const daemon = new InkPiDaemon({ executionEnv: environment() });
    expect(daemon.getTaskRouter().toolRegistry.get('env_read_file')).toBeDefined();
    expect(daemon.getTaskRouter().toolRegistry.get('env_write_file')).toBeUndefined();
    expect(daemon.getTaskRouter().toolRegistry.get('env_run_process')).toBeUndefined();
    await fs.writeFile(path.join(root, 'chapter.txt'), 'actual chapter');
    const registry = daemon.getTaskRouter().toolRegistry;
    const result = await registry.executeTool({
      type: 'toolCall',
      id: 'read',
      name: 'env_read_file',
      arguments: { path: 'chapter.txt' }
    });
    expect(result.content).toEqual([{ type: 'text', text: 'actual chapter' }]);
  });

  it('uses owner-side bounded resource reads without invoking the legacy full read', async () => {
    await fs.writeFile(path.join(root, 'chapter.txt'), 'first\nsecond\nthird');
    const read = vi.fn(async () => {
      throw new Error('full read must not execute');
    });
    const registry = new ToolRegistry();
    const adapter = {
      read,
      list: async () => [],
      readRange: (name: string, request: Parameters<NodeExecutionEnv['readText']>[1], signal?: AbortSignal) =>
        environment().readText(name, request, signal),
      proposeMutation: async () => ({
        proposalId: 'p',
        status: 'proposed' as const,
        resourceId: 'r',
        operation: 'replace' as const
      })
    };
    for (const tool of createDocumentResourceTools(adapter)) registry.register(tool);
    const result = await registry.executeTool({
      type: 'toolCall',
      id: 'read',
      name: 'read_resource',
      arguments: { resourceId: 'chapter.txt', startLine: 2, maxLines: 1 }
    });
    expect(result.content).toEqual([{ type: 'text', text: 'second\n' }]);
    expect(read).not.toHaveBeenCalled();
    expect(createExecutionEnvTools(environment()).every((tool) => tool.replay === 'safe')).toBe(true);
  });

  it('does not flush a partial UTF-8 character at the scan budget', async () => {
    await fs.writeFile(path.join(root, 'split'), '\n中');
    const result = await environment({ maxScanBytes: 2 }).readText('split', { startLine: 2 });
    expect(result.text).toBe('');
    expect(result.scanLimitReached).toBe(true);
    expect(result.skippedBytes).toBe(2);
  });

  it('awaits active mutation cleanup after cancellation instead of releasing its owner early', async () => {
    const entered = deferred();
    const finish = deferred();
    const controller = new AbortController();
    controls.renameGate = async () => {
      entered.release();
      await finish.promise;
    };
    const writing = environment({ allowWrite: true }).writeText('active', 'committed', controller.signal);
    let settled = false;
    const settledWriting = writing.finally(() => {
      settled = true;
    });
    await entered.promise;
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish.release();
    await expect(settledWriting).resolves.toMatchObject({ bytesWritten: 9 });
    expect(await fs.readdir(root)).toEqual(['active']);
  });

  it('limits child-process progress notifications by time and keeps their snapshots bounded', async () => {
    const progress: number[] = [];
    const env = environment({
      executables: { node: process.execPath },
      maxOutputCharacters: 100,
      progressIntervalMs: 100
    });
    await env.runProcess(
      {
        command: 'node',
        args: [
          '-e',
          "let n=0; const timer=setInterval(()=>{process.stdout.write('x'.repeat(1000)); if(++n===100) clearInterval(timer)},5)"
        ]
      },
      undefined,
      (snapshot) => {
        expect(snapshot.stdout.content.length).toBeLessThanOrEqual(100);
        progress.push(performance.now());
      }
    );
    expect(progress.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < progress.length; index++)
      expect(progress[index] - progress[index - 1]).toBeGreaterThanOrEqual(95);
  });

  it('keeps RSS bounded when scanning a 100 MiB file in an actual isolated process', async () => {
    const file = await fs.open(path.join(root, 'large'), 'w');
    await file.truncate(100 * 1024 * 1024);
    await file.close();
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'packages/server/dist/node-execution-env.js')).href;
    const script =
      "const {NodeExecutionEnv}=await import(process.argv[1]); global.gc(); const before=process.memoryUsage().rss; const result=await new NodeExecutionEnv({root:process.argv[2],maxScanBytes:1024*1024}).readText('large',{startLine:100}); process.stdout.write(JSON.stringify({delta:process.memoryUsage().rss-before,result}));";
    const child = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', script, moduleUrl, root], {
      shell: false,
      timeout: 10000
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    const measured = JSON.parse(child.stdout.toString());
    expect(measured.result.snapshotBytes).toBe(100 * 1024 * 1024);
    expect(measured.result.scannedBytes).toBe(1024 * 1024);
    expect(measured.result.retainedBytes).toBe(0);
    expect(measured.delta).toBeLessThan(64 * 1024 * 1024);
  });
});
