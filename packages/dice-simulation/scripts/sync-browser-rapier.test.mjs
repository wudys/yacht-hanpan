import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DETERMINISTIC_RAPIER_WASM_FILE } from '../src/rapier/browser-rapier-asset.ts';
import { syncBrowserRapier } from './sync-browser-rapier.mjs';

test('replaces obsolete Rapier binaries while preserving unrelated runtime assets', async () => {
  const target = await mkdtemp(path.join(tmpdir(), 'rapier-runtime-'));
  try {
    await writeFile(path.join(target, 'rapier-deterministic-0.19.2.wasm'), 'old');
    await writeFile(path.join(target, 'other.wasm'), 'unrelated');
    await syncBrowserRapier(target);
    await syncBrowserRapier(target);
    expect((await readdir(target)).sort()).toEqual(['other.wasm', DETERMINISTIC_RAPIER_WASM_FILE]);
    expect(await Bun.file(path.join(target, 'other.wasm')).text()).toBe('unrelated');
    expect(
      await WebAssembly.compile(
        await Bun.file(path.join(target, DETERMINISTIC_RAPIER_WASM_FILE)).arrayBuffer(),
      ),
    ).toBeInstanceOf(WebAssembly.Module);
  } finally {
    await rm(target, { recursive: true, force: true });
  }
});
