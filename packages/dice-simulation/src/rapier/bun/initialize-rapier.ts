import { fileURLToPath } from 'node:url';

import RAPIER from '@dimforge/rapier3d-deterministic';
import * as rapierGlue from '@dimforge/rapier3d-deterministic/rapier_wasm3d_bg';

import { markRapierReady } from '../state';

let initialization: Promise<string> | undefined;

export function initializeDeterministicRapierForBun(): Promise<string> {
  initialization ??= initializeWasm();
  return initialization;
}

async function initializeWasm(): Promise<string> {
  const wasmPath = fileURLToPath(
    import.meta.resolve('@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.wasm'),
  );
  const wasmModule = await WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer());
  const wasmInstance = await WebAssembly.instantiate(wasmModule, {
    './rapier_wasm3d_bg.js': rapierGlue,
  });
  rapierGlue.__wbg_set_wasm(wasmInstance.exports);
  markRapierReady();
  return RAPIER.version();
}
