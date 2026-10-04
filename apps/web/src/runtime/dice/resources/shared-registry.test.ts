import { describe, expect, test, vi } from 'vitest';

import { SharedResourceRegistry } from '@/runtime/dice/resources/shared-registry';

describe('SharedResourceRegistry', () => {
  test('deduplicates concurrent preload and disposes once', async () => {
    const dispose = vi.fn(() => undefined);
    const create = vi.fn(async () => ({ dispose }));
    const registry = new SharedResourceRegistry(create);

    const first = registry.preload();
    const second = registry.preload();
    expect(first).toBe(second);
    const [left, right] = await Promise.all([first, second]);
    expect(left).toBe(right);
    expect(create).toHaveBeenCalledTimes(1);

    await registry.dispose();
    await registry.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('allows a clean reload after explicit disposal', async () => {
    const create = vi.fn(async () => ({ dispose: () => undefined }));
    const registry = new SharedResourceRegistry(create);
    await registry.preload();
    await registry.dispose();
    await registry.preload();
    expect(create).toHaveBeenCalledTimes(2);
  });

  test('does not cache failed initialization', async () => {
    let attempts = 0;
    const registry = new SharedResourceRegistry(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('gpu unavailable');
      return { dispose: () => undefined };
    });
    await expect(registry.preload()).rejects.toThrow('gpu unavailable');
    await expect(registry.preload()).resolves.toBeDefined();
  });

  test('rejects synchronous factory failures and permits a clean retry', async () => {
    const resource = { dispose: vi.fn(() => undefined) };
    const create = vi.fn(() => {
      if (create.mock.calls.length === 1) throw new Error('gpu unavailable');
      return resource;
    });
    const registry = new SharedResourceRegistry(create);

    await expect(registry.preload()).rejects.toThrow('gpu unavailable');
    await expect(registry.preload()).resolves.toBe(resource);
    expect(create).toHaveBeenCalledTimes(2);
    await registry.dispose();
    expect(resource.dispose).toHaveBeenCalledTimes(1);
  });

  test('disposes a resource once when disposal overlaps initialization', async () => {
    const resource = { dispose: vi.fn(() => undefined) };
    let finish!: (value: typeof resource) => void;
    const registry = new SharedResourceRegistry(
      () =>
        new Promise<typeof resource>((resolve) => {
          finish = resolve;
        }),
    );
    const loading = registry.preload();
    const firstDisposal = registry.dispose();
    const secondDisposal = registry.dispose();
    await Promise.resolve();
    finish(resource);
    await Promise.all([loading, firstDisposal, secondDisposal]);
    expect(resource.dispose).toHaveBeenCalledTimes(1);
  });
});
