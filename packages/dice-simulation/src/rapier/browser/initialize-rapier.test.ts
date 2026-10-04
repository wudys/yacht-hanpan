import * as rapierGlue from '@dimforge/rapier3d-deterministic/rapier_wasm3d_bg';
import { describe, expect, mock, spyOn, test } from 'bun:test';

import {
  createBrowserRapierLoader,
  initializeDeterministicRapierForBrowser,
} from './initialize-rapier';

describe('browser deterministic Rapier initializer', () => {
  test('deduplicates concurrent initialization for one exact WASM URL', async () => {
    const loadWasm = mock(async () => undefined);
    const markReady = mock(() => undefined);
    const initialize = createBrowserRapierLoader({ loadWasm, markReady, version: () => '0.19.3' });
    const [left, right] = await Promise.all([
      initialize('/runtime/rapier.wasm'),
      initialize('/runtime/rapier.wasm'),
    ]);
    expect([left, right]).toEqual(['0.19.3', '0.19.3']);
    expect(loadWasm).toHaveBeenCalledTimes(1);
    expect(markReady).toHaveBeenCalledTimes(1);
  });

  test('rejects a second URL instead of silently mixing runtime binaries', async () => {
    const initialize = createBrowserRapierLoader({
      loadWasm: async () => undefined,
      markReady: () => undefined,
      version: () => '0.19.3',
    });
    await initialize('/runtime/first.wasm');
    await expect(initialize('/runtime/other.wasm')).rejects.toThrow(
      'Rapier browser WASM URL mismatch',
    );
  });

  test('does not cache failed loading', async () => {
    let attempts = 0;
    const initialize = createBrowserRapierLoader({
      loadWasm: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('network failure');
      },
      markReady: () => undefined,
      version: () => '0.19.3',
    });
    await expect(initialize('/runtime/rapier.wasm')).rejects.toThrow('network failure');
    await expect(initialize('/runtime/rapier.wasm')).resolves.toBe('0.19.3');
  });
});

test('aborts shared initialization immediately and ignores its late success after retry', async () => {
  const controller = new AbortController();
  let finish!: () => void;
  const markReady = mock(() => undefined);
  const version = mock(() => '0.19.3');
  const loadWasm = mock(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const initialize = createBrowserRapierLoader({ loadWasm, markReady, version });
  const first = initialize('/runtime/rapier.wasm', controller.signal);
  const observed = first.catch((error: unknown) => error);
  expect(initialize('/runtime/rapier.wasm')).toBe(first);
  controller.abort(new Error('preparation expired'));
  await Promise.resolve();
  const pending = Symbol('pending');
  expect(await Promise.race([observed, Promise.resolve(pending)])).not.toBe(pending);
  expect(loadWasm).toHaveBeenCalledWith('/runtime/rapier.wasm', controller.signal);
  const finishOld = finish;
  const retry = initialize('/runtime/rapier.wasm');
  expect(retry).not.toBe(first);
  finishOld();
  await Promise.resolve();
  await Promise.resolve();
  expect(markReady).not.toHaveBeenCalled();
  expect(version).not.toHaveBeenCalled();
  expect(initialize('/runtime/rapier.wasm')).toBe(retry);
  finish();
  await expect(retry).resolves.toBe('0.19.3');
  expect(markReady).toHaveBeenCalledTimes(1);
});

test('does not start an already aborted attempt', async () => {
  const loadWasm = mock(async () => undefined);
  const initialize = createBrowserRapierLoader({
    loadWasm,
    markReady: () => {},
    version: () => '0.19.3',
  });
  await expect(
    initialize('/runtime/rapier.wasm', AbortSignal.abort(new Error('cancelled'))),
  ).rejects.toThrow('cancelled');
  expect(loadWasm).not.toHaveBeenCalled();
});

test.each(['resolve', 'reject'] as const)(
  'aborts the fetch and ignores late streaming %s',
  async (completion) => {
    const controller = new AbortController();
    const response = new Response(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const fetchRequest = spyOn(globalThis, 'fetch').mockResolvedValue(response);
    let finish!: (value: WebAssembly.WebAssemblyInstantiatedSource) => void;
    let fail!: (reason: unknown) => void;
    const streaming = spyOn(WebAssembly, 'instantiateStreaming').mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    const fallback = spyOn(WebAssembly, 'instantiate');
    const install = spyOn(rapierGlue, '__wbg_set_wasm');
    try {
      const initialization = initializeDeterministicRapierForBrowser(
        '/runtime/rapier.wasm',
        controller.signal,
      );
      const observed = initialization.catch((error: unknown) => error);
      await Promise.resolve();
      expect(streaming).toHaveBeenCalledTimes(1);
      expect(fetchRequest).toHaveBeenCalledWith('/runtime/rapier.wasm', {
        signal: controller.signal,
      });
      const reason = new Error('preparation expired');
      controller.abort(reason);
      expect(await observed).toBe(reason);
      if (completion === 'resolve') {
        const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
        finish({ module, instance: new WebAssembly.Instance(module) });
      } else fail(new Error('stream stopped'));
      await Promise.resolve();
      await Promise.resolve();
      expect(install).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      fetchRequest.mockRestore();
      streaming.mockRestore();
      fallback.mockRestore();
      install.mockRestore();
    }
  },
);
