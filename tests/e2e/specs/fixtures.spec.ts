import { readdirSync } from 'node:fs';

import { expect } from '@playwright/test';

import { test } from '../helpers/test';
import { PRODUCTION_GAME_ORIGIN } from '../helpers/test-origins';

test('production web build serves deterministic WASM without duplicate binaries', async ({
  request,
}) => {
  const page = await request.get(PRODUCTION_GAME_ORIGIN);
  expect(page.ok()).toBe(true);
  const wasm = await request.get(
    `${PRODUCTION_GAME_ORIGIN}/runtime/rapier-deterministic-0.19.3.wasm`,
  );
  expect(wasm.ok()).toBe(true);
  expect((await wasm.body()).byteLength).toBeGreaterThan(1_000_000);
  const wasmOutputs = readdirSync(new URL('../../../apps/web/dist/', import.meta.url), {
    recursive: true,
  }).filter((path) => path.toString().endsWith('.wasm'));
  expect(wasmOutputs).toEqual(['runtime/rapier-deterministic-0.19.3.wasm']);
});
