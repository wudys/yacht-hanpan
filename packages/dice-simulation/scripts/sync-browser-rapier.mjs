import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  DETERMINISTIC_RAPIER_WASM_FILE,
  DETERMINISTIC_RAPIER_WASM_PATH,
} from '../src/rapier/bun/index.ts';

export async function syncBrowserRapier(target) {
  const output = path.resolve(target, DETERMINISTIC_RAPIER_WASM_FILE);
  await mkdir(path.dirname(output), { recursive: true });
  await cp(DETERMINISTIC_RAPIER_WASM_PATH, output);
  for (const name of await readdir(path.dirname(output))) {
    if (
      /^rapier-deterministic-\d+\.\d+\.\d+\.wasm$/u.test(name) &&
      name !== DETERMINISTIC_RAPIER_WASM_FILE
    ) {
      await rm(path.join(path.dirname(output), name));
    }
  }
  return output;
}

if (import.meta.main) {
  const targetIndex = process.argv.indexOf('--target');
  const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
  if (!target) throw new Error('usage: bun sync-browser-rapier.mjs --target <directory>');
  console.log(await syncBrowserRapier(target));
}
