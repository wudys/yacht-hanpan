import * as rapierGlue from '@dimforge/rapier3d-deterministic/rapier_wasm3d_bg';

import { markRapierReady } from '../state';

export type BrowserRapierLoaderDependencies = Readonly<{
  loadWasm: (wasmUrl: string, signal?: AbortSignal) => Promise<void>;
  markReady: () => void;
  version: () => string;
}>;

export function createBrowserRapierLoader({
  loadWasm,
  markReady,
  version,
}: BrowserRapierLoaderDependencies): (wasmUrl: string, signal?: AbortSignal) => Promise<string> {
  let initializedUrl: string | null = null;
  let initialization: Promise<string> | null = null;

  return (wasmUrl: string, signal?: AbortSignal) => {
    if (initializedUrl !== null && initializedUrl !== wasmUrl) {
      return Promise.reject(new Error('Rapier browser WASM URL mismatch'));
    }
    if (initialization) return initialization;
    if (signal?.aborted) return Promise.reject(signal.reason);
    let complete!: (version: string) => void;
    let decline!: (error: unknown) => void;
    const pending = new Promise<string>((resolve, reject) => {
      complete = resolve;
      decline = reject;
    });
    initialization = pending;
    initializedUrl = wasmUrl;
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      initialization = null;
      initializedUrl = null;
      decline(error);
    };
    function onAbort(): void {
      fail(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      void loadWasm(wasmUrl, signal)
        .then(() => {
          if (settled) return;
          signal?.throwIfAborted();
          const rapierVersion = version();
          markReady();
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          complete(rapierVersion);
        })
        .catch(fail);
    } catch (error) {
      fail(error);
    }
    return pending;
  };
}

async function loadRapierWasm(wasmUrl: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(wasmUrl, { signal });
  if (!response.ok) throw new Error(`dice simulation WASM request failed: ${response.status}`);
  const imports = { './rapier_wasm3d_bg.js': rapierGlue };
  let instance: WebAssembly.Instance;
  try {
    // Bun and DOM currently expose structurally different Response declarations.
    const result = await WebAssembly.instantiateStreaming(
      response.clone() as unknown as globalThis.Response,
      imports,
    );
    instance = result.instance;
  } catch {
    signal?.throwIfAborted();
    const result = await WebAssembly.instantiate(await response.arrayBuffer(), imports);
    instance = result.instance;
  }
  signal?.throwIfAborted();
  rapierGlue.__wbg_set_wasm(instance.exports);
}

export const initializeDeterministicRapierForBrowser = createBrowserRapierLoader({
  loadWasm: loadRapierWasm,
  markReady: markRapierReady,
  version: () => rapierGlue.version(),
});
