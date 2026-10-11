import { describe, expect, test, vi } from 'vitest';

import type { CanvasFactory } from '@/runtime/dice/resources/canvas-factory';
import { createProceduralResourceCache } from '@/runtime/dice/resources/procedural-resource-cache';
import {
  createProceduralDiceResources,
  type ProceduralDiceResources,
} from '@/runtime/dice/resources/procedural-resources';

function createResources() {
  const createCanvas = ((width: number, height: number) => ({
    width,
    height,
    getContext: () => ({ fillStyle: '', fillRect() {}, beginPath() {}, arc() {}, fill() {} }),
  })) as unknown as CanvasFactory;
  const resources = createProceduralDiceResources(createCanvas);
  return { ...resources, dispose: vi.fn(resources.dispose) };
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('createProceduralResourceCache', () => {
  test('deduplicates concurrent preload and disposes once', async () => {
    const create = vi.fn(createResources);
    const cache = createProceduralResourceCache(create);

    try {
      const first = cache.preload();
      const second = cache.preload();
      expect(first).toBe(second);
      const [left, right] = await Promise.all([first, second]);
      expect(left).toBe(right);
      await expect(cache.preload()).resolves.toBe(left);
      expect(create).toHaveBeenCalledTimes(1);

      await cache.dispose();
      await cache.dispose();
      expect(left.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await cache.dispose();
    }
  });

  test('allows a clean reload after explicit disposal', async () => {
    const create = vi.fn(createResources);
    const cache = createProceduralResourceCache(create);

    try {
      const first = await cache.preload();
      await cache.dispose();
      const second = await cache.preload();
      expect(second).not.toBe(first);
      expect(second.dieGeometry).not.toBe(first.dieGeometry);
      expect(create).toHaveBeenCalledTimes(2);
      expect(first.dispose).toHaveBeenCalledTimes(1);
      expect(second.dispose).not.toHaveBeenCalled();
      await cache.dispose();
      expect(second.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await cache.dispose();
    }
  });

  test('does not cache failed initialization', async () => {
    let attempts = 0;
    const cache = createProceduralResourceCache(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('gpu unavailable');
      return createResources();
    });

    try {
      await expect(cache.preload()).rejects.toThrow('gpu unavailable');
      const resources = await cache.preload();
      await expect(cache.preload()).resolves.toBe(resources);
      expect(attempts).toBe(2);
      await cache.dispose();
      expect(resources.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await cache.dispose();
    }
  });

  test('rejects synchronous factory failures and permits a clean retry', async () => {
    const create = vi.fn(() => {
      if (create.mock.calls.length === 1) throw new Error('gpu unavailable');
      return createResources();
    });
    const cache = createProceduralResourceCache(create);

    try {
      await expect(cache.preload()).rejects.toThrow('gpu unavailable');
      const resources = await cache.preload();
      await expect(cache.preload()).resolves.toBe(resources);
      expect(create).toHaveBeenCalledTimes(2);
      await cache.dispose();
      expect(resources.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await cache.dispose();
    }
  });

  test('disposes a resource once when disposal overlaps initialization', async () => {
    const pending = deferred<ProceduralDiceResources>();
    let finish!: () => void;
    const cache = createProceduralResourceCache(() => {
      const resources = createResources();
      finish = () => pending.resolve(resources);
      return pending.promise;
    });
    const loading = cache.preload();
    const firstDisposal = cache.dispose();
    const secondDisposal = cache.dispose();
    await Promise.resolve();
    finish();
    try {
      const [resource] = await Promise.all([loading, firstDisposal, secondDisposal]);
      expect(resource.dispose).toHaveBeenCalledTimes(1);
    } finally {
      await cache.dispose();
    }
  });
});
