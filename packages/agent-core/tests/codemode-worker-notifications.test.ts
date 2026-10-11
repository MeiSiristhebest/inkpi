import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { describe, expect, it } from 'vitest';

describe('CodeMode worker watch notification compatibility', () => {
  it('ignores Node watch dependency events and settles the execution result', async () => {
    const workerDirectory = await mkdtemp(join(tmpdir(), 'inkpi-codemode-watch-'));
    const workerPath = join(workerDirectory, 'worker.mjs');
    await writeFile(
      workerPath,
      [
        "import { parentPort } from 'node:worker_threads';",
        "parentPort.postMessage({ 'watch:import': 'file:///dependency.mjs' });",
        "parentPort.postMessage({ 'watch:require': 'file:///dependency.cjs' });",
        "parentPort.postMessage({ type: 'done', ok: true, value: JSON.stringify('finished'), writes: '[]' });"
      ].join('\n')
    );

    const wasm = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const sandbox = new CodemodeSandbox({
      workerUrl: pathToFileURL(workerPath),
      wasm,
      timeoutMs: 5_000
    });
    try {
      const result = await sandbox.execute("return 'ignored';");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('finished');
    } finally {
      await sandbox.close();
      await rm(workerDirectory, { recursive: true, force: true });
    }
  });
});
