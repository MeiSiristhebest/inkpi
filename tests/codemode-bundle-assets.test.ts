import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEmbeddedCodemodeWasm } from '../packages/agent-core/src/codemode-bundle-assets.js';

afterEach(() => vi.unstubAllGlobals());

describe('embedded CodeMode WASM assets', () => {
  it('uses the package default when Bun has no embedded QuickJS resource', () => {
    vi.stubGlobal('Bun', {
      embeddedFiles: [{ name: 'other.wasm', type: 'application/wasm', arrayBuffer: vi.fn() }]
    });

    expect(getEmbeddedCodemodeWasm()).toBeUndefined();
  });

  it('compiles and caches the single embedded QuickJS resource', async () => {
    const wasmBytes = new ArrayBuffer(8);
    new Uint8Array(wasmBytes).set([0, 97, 115, 109, 1, 0, 0, 0]);
    const arrayBuffer = vi.fn(async () => wasmBytes);
    vi.stubGlobal('Bun', {
      embeddedFiles: [
        { name: 'other.wasm', type: 'application/wasm', arrayBuffer: vi.fn() },
        { name: 'quickjs-test.wasm', type: 'application/wasm', arrayBuffer }
      ]
    });

    const wasmPromise = getEmbeddedCodemodeWasm();
    if (!wasmPromise) throw new Error('Expected the embedded QuickJS resource to be selected.');
    const wasm = await wasmPromise;

    expect(wasm).toBeDefined();
    expect(getEmbeddedCodemodeWasm()).toBe(wasmPromise);
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });
});
