import { fileURLToPath } from 'node:url';

export { DETERMINISTIC_RAPIER_WASM_FILE } from '../browser-rapier-asset';

export const DETERMINISTIC_RAPIER_WASM_PATH = fileURLToPath(
  import.meta.resolve('@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.wasm'),
);
