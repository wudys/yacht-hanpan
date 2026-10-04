import { describe, expect, test } from 'bun:test';

import {
  DETERMINISTIC_RAPIER_WASM_FILE,
  DETERMINISTIC_RAPIER_WASM_PATH,
  initializeDeterministicRapierForBun,
} from './index';

describe('Bun deterministic Rapier runtime', () => {
  test('initializes once and reports the pinned runtime version', async () => {
    const first = initializeDeterministicRapierForBun();
    const second = initializeDeterministicRapierForBun();

    expect(second).toBe(first);
    await expect(first).resolves.toBe('0.19.3');
  });

  test('exposes the browser runtime asset through the public Bun entry point', async () => {
    expect(DETERMINISTIC_RAPIER_WASM_FILE).toBe('rapier-deterministic-0.19.3.wasm');
    expect(await Bun.file(DETERMINISTIC_RAPIER_WASM_PATH).arrayBuffer()).toHaveProperty(
      'byteLength',
    );
  });
});
