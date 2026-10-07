// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';

import { VISUAL_ASSET_MANIFEST } from '@/bootstrap/preload-assets';
import { createProductVisualResources } from '@/bootstrap/product-visual-resources';
import type { ProceduralDiceResources } from '@/runtime/dice/resources';
import { createProceduralDiceResources } from '@/runtime/dice/resources/procedural-resources';

vi.mock('@/runtime/dice/resources/procedural-resources', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/runtime/dice/resources/procedural-resources')>();
  return { ...actual, createProceduralDiceResources: vi.fn(actual.createProceduralDiceResources) };
});

afterEach(() => vi.mocked(createProceduralDiceResources).mockReset());

function createProceduralResources(dispose: () => void = vi.fn()): ProceduralDiceResources {
  return { dispose } as unknown as ProceduralDiceResources;
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('createProductVisualResources', () => {
  test('lazily owns separate default procedural resources while reusing each owner preload', async () => {
    const leftResources = createProceduralResources();
    const rightResources = createProceduralResources();
    vi.mocked(createProceduralDiceResources)
      .mockReturnValueOnce(leftResources)
      .mockReturnValueOnce(rightResources);
    const options = {
      decodeAsset: async () => new Image(),
      initializeRuntime: vi.fn(async () => 'ready'),
    };
    const left = createProductVisualResources(options);
    const right = createProductVisualResources(options);
    expect(createProceduralDiceResources).not.toHaveBeenCalled();
    expect(options.initializeRuntime).not.toHaveBeenCalled();

    try {
      const [loadedLeft, loadedRight] = await Promise.all([left.preload(), right.preload()]);
      expect(loadedLeft).toBe(leftResources);
      expect(loadedRight).toBe(rightResources);
      await left.dispose();
      expect(leftResources.dispose).toHaveBeenCalledOnce();
      expect(rightResources.dispose).not.toHaveBeenCalled();
      await expect(right.preload()).resolves.toBe(rightResources);
      expect(createProceduralDiceResources).toHaveBeenCalledTimes(2);
    } finally {
      await Promise.all([left.dispose(), right.dispose()]);
    }
    expect(rightResources.dispose).toHaveBeenCalledOnce();
  });

  test('aborts pending preparation and immediately retries without waiting for the old WASM', async () => {
    const activity = new AbortController();
    const oldWasm = deferred<string>();
    const resources = createProceduralResources();
    const initializeRuntime = vi
      .fn()
      .mockReturnValueOnce(oldWasm.promise)
      .mockResolvedValue('ready');
    const runtime = createProductVisualResources({
      decodeAsset: async () => new Image(),
      initializeRuntime,
      proceduralRegistry: {
        preload: async () => resources,
        dispose: async () => resources.dispose(),
      },
    });
    const report = vi.fn();
    const loading = runtime.preload(report, activity.signal).catch((error: unknown) => error);
    activity.abort();
    expect(initializeRuntime.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(await loading).toBe(activity.signal.reason);
    report.mockClear();
    await expect(runtime.preload()).resolves.toBe(resources);
    oldWasm.resolve('late');
    await Promise.resolve();
    expect(report).not.toHaveBeenCalled();
    expect(initializeRuntime).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  test('removes a failed procedural preload reporter before retrying', async () => {
    vi.stubGlobal('document', {
      createElement() {
        throw new Error('canvas unavailable');
      },
    });
    const runtime = createProductVisualResources({
      decodeAsset: async () => new Image(),
      initializeRuntime: async () => 'rapier-version',
    });
    const firstReport = vi.fn();
    const retryReport = vi.fn();
    try {
      await expect(runtime.preload(firstReport)).rejects.toThrow('canvas unavailable');
      firstReport.mockClear();
      await expect(runtime.preload(retryReport)).rejects.toThrow('canvas unavailable');
      expect(firstReport).not.toHaveBeenCalled();
      expect(retryReport).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await runtime.dispose();
    }
  });

  test('reports decoded resource completion while WASM remains pending', async () => {
    const wasm = deferred<string>();
    const updates: { phase: string; completed: number }[] = [];
    const runtime = createProductVisualResources({
      decodeAsset: async () => new Image(),
      initializeRuntime: () => wasm.promise,
      proceduralRegistry: {
        preload: async () => createProceduralResources(),
        dispose: async () => {},
      },
    });
    const loading = runtime.preload((phase, completed) => updates.push({ phase, completed }));
    await vi.waitFor(() =>
      expect(updates.some((entry) => entry.phase === 'assets' && entry.completed > 0)).toBe(true),
    );
    expect(updates.filter((entry) => entry.phase === 'wasm').at(-1)?.completed).toBe(0);
    wasm.resolve('rapier-version');
    await loading;
    expect(updates.filter((entry) => entry.phase === 'wasm').at(-1)?.completed).toBe(1);
    await runtime.dispose();
  });

  test('deduplicates preload work and returns one procedural resource identity', async () => {
    const resources = createProceduralResources();
    const preloadProcedural = vi.fn(async () => resources);
    const initializeRuntime = vi.fn(async () => 'rapier-version');
    const decodeAsset = vi.fn(async () => new Image());
    const runtime = createProductVisualResources({
      decodeAsset,
      initializeRuntime,
      proceduralRegistry: { preload: preloadProcedural, dispose: async () => resources.dispose() },
    });

    const [left, right] = await Promise.all([runtime.preload(), runtime.preload()]);
    const repeated = await runtime.preload();

    expect(left).toBe(resources);
    expect(right).toBe(left);
    expect(repeated).toBe(left);
    expect(initializeRuntime).toHaveBeenCalledTimes(1);
    expect(decodeAsset).toHaveBeenCalledTimes(VISUAL_ASSET_MANIFEST.length);
    expect(preloadProcedural).toHaveBeenCalledTimes(1);
  });

  test('retries a failed decode while reusing WASM and the registry resource', async () => {
    const resources = createProceduralResources();
    const preloadProcedural = vi.fn(async () => resources);
    const initializeRuntime = vi.fn(async () => 'rapier-version');
    let rejectNextDecode = true;
    const decodeAsset = vi.fn(async () => {
      if (rejectNextDecode) {
        rejectNextDecode = false;
        throw new Error('decode failed');
      }
      return new Image();
    });
    const runtime = createProductVisualResources({
      decodeAsset,
      initializeRuntime,
      proceduralRegistry: { preload: preloadProcedural, dispose: async () => resources.dispose() },
    });

    await expect(runtime.preload()).rejects.toThrow('decode failed');
    await expect(runtime.preload()).resolves.toBe(resources);

    expect(initializeRuntime).toHaveBeenCalledTimes(1);
    expect(preloadProcedural).toHaveBeenCalledTimes(2);
    expect(decodeAsset).toHaveBeenCalledTimes(VISUAL_ASSET_MANIFEST.length * 2);
  });

  test('disposal during preload cleans completed resources and prevents recreation', async () => {
    const assetGate = deferred<void>();
    const disposeProcedural = vi.fn();
    const resources = createProceduralResources(disposeProcedural);
    vi.mocked(createProceduralDiceResources).mockReturnValueOnce(resources);
    const initializeRuntime = vi.fn(async () => 'rapier-version');
    const decodeAsset = vi.fn(async () => {
      await assetGate.promise;
      return new Image();
    });
    const runtime = createProductVisualResources({
      decodeAsset,
      initializeRuntime,
    });

    const preload = runtime.preload();
    const disposal = runtime.dispose();
    assetGate.resolve();

    await expect(preload).rejects.toThrow('Product visual resources are disposed');
    await disposal;
    expect(disposeProcedural).toHaveBeenCalledTimes(1);
    await expect(runtime.preload()).rejects.toThrow('Product visual resources are disposed');
    expect(initializeRuntime).toHaveBeenCalledTimes(1);
    expect(decodeAsset).toHaveBeenCalledTimes(VISUAL_ASSET_MANIFEST.length);
    expect(createProceduralDiceResources).toHaveBeenCalledTimes(1);
  });
});
