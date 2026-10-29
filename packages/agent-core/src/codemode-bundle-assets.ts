import type { CodemodeWasmModule } from '@earendil-works/pi-codemode';

interface EmbeddedWasmFile {
  readonly name: string;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface BunRuntime {
  readonly embeddedFiles?: readonly EmbeddedWasmFile[];
}

interface WebAssemblyRuntime {
  compile(bytes: ArrayBuffer): Promise<CodemodeWasmModule>;
}

const quickjsWasmName = /^quickjs(?:-[^.]+)?\.wasm$/u;
let embeddedQuickjsWasm: Promise<CodemodeWasmModule> | undefined;

/** Returns the QuickJS module embedded by Bun's standalone bundler, if present. */
export function getEmbeddedCodemodeWasm(): Promise<CodemodeWasmModule> | undefined {
  // SAFETY: Bun exposes its embedded file list on the Bun runtime global; Node may omit `Bun` entirely.
  const bun = (globalThis as unknown as { Bun?: BunRuntime }).Bun;
  const wasmFiles = bun?.embeddedFiles?.filter(
    (file) => file.type === 'application/wasm' && quickjsWasmName.test(file.name)
  );
  if (!wasmFiles?.length) return undefined;
  if (wasmFiles.length !== 1) {
    throw new Error(`Expected one embedded QuickJS WASM resource; found ${wasmFiles.length}.`);
  }
  if (!embeddedQuickjsWasm) {
    // SAFETY: `compile` is called only after checking that the host provides this standard API.
    const webAssembly = (globalThis as unknown as { WebAssembly?: WebAssemblyRuntime }).WebAssembly;
    if (!webAssembly) throw new Error('WebAssembly is unavailable for the embedded QuickJS resource.');
    embeddedQuickjsWasm = wasmFiles[0]
      .arrayBuffer()
      .then((bytes) => webAssembly.compile(bytes))
      .catch((error) => {
        embeddedQuickjsWasm = undefined;
        if (error instanceof Error) throw error;
        throw new Error(`Failed to compile embedded QuickJS WASM: ${String(error)}`);
      });
  }
  return embeddedQuickjsWasm;
}
