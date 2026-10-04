// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';

import { createAssetPreloader, type VisualAssetManifestEntry } from '@/bootstrap/preload-assets';

const manifest: readonly VisualAssetManifestEntry[] = [
  {
    id: 'first',
    kind: 'svg',
    url: '/first.svg',
    bytes: 1,
    sha256: 'a'.repeat(64),
    mime: 'image/svg+xml',
  },
  {
    id: 'second',
    kind: 'image',
    url: '/second.png',
    bytes: 1,
    sha256: 'b'.repeat(64),
    mime: 'image/png',
  },
];

describe('createAssetPreloader', () => {
  test('reports failure immediately and ignores late completion after a successful retry', async () => {
    let complete!: (image: HTMLImageElement) => void;
    const late = new Promise<HTMLImageElement>((resolve) => {
      complete = resolve;
    });
    let firstAttempt = true;
    const decode = vi.fn(async ({ id }: VisualAssetManifestEntry) => {
      if (firstAttempt) {
        if (id === 'first') throw new Error('decode failed');
        return late;
      }
      return new Image();
    });
    const preloader = createAssetPreloader(manifest, decode);
    await expect(preloader.preload()).rejects.toThrow('decode failed');
    firstAttempt = false;
    await preloader.preload();
    complete(new Image());
    await late;
    await preloader.preload();
    expect(decode).toHaveBeenCalledTimes(4);
    await preloader.dispose();
  });

  test('cancels pending decoders and permits a fresh attempt before they settle', async () => {
    const activity = new AbortController();
    const signals: AbortSignal[] = [];
    let complete!: (image: HTMLImageElement) => void;
    const pending = new Promise<HTMLImageElement>((resolve) => {
      complete = resolve;
    });
    const preloader = createAssetPreloader(manifest.slice(0, 1), (_entry, signal) => {
      signals.push(signal);
      return signals.length === 1 ? pending : Promise.resolve(new Image());
    });
    const loading = preloader.preload(activity.signal).catch((error: unknown) => error);
    activity.abort();
    expect(signals[0]?.aborted).toBe(true);
    expect(await loading).toBe(activity.signal.reason);
    await preloader.preload();
    complete(new Image());
    await pending;
    await preloader.preload();
    expect(signals).toHaveLength(2);
    await preloader.dispose();
  });

  test('deduplicates a successful readiness load', async () => {
    const decode = vi.fn(async () => new Image());
    const preloader = createAssetPreloader(manifest, decode);
    await Promise.all([preloader.preload(), preloader.preload()]);
    await preloader.preload();
    expect(decode).toHaveBeenCalledTimes(2);
  });

  test('cancels pending decode on disposal without retaining its late completion', async () => {
    let complete!: (image: HTMLImageElement) => void;
    const pending = new Promise<HTMLImageElement>((resolve) => {
      complete = resolve;
    });
    const decode = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(new Image());
    const preloader = createAssetPreloader(manifest.slice(0, 1), decode);
    const loading = expect(preloader.preload()).rejects.toThrow('Asset preparation disposed');
    await Promise.all([preloader.dispose(), preloader.dispose(), loading]);
    complete(new Image());
    await pending;
    await preloader.preload();
    expect(decode).toHaveBeenCalledTimes(2);
  });

  test('retries failed decode and reloads after disposal', async () => {
    const decode = vi
      .fn()
      .mockRejectedValueOnce(new Error('decode failed'))
      .mockResolvedValue(new Image());
    const preloader = createAssetPreloader(manifest.slice(0, 1), decode);
    await expect(preloader.preload()).rejects.toThrow('decode failed');
    await preloader.preload();
    await preloader.dispose();
    await preloader.preload();
    expect(decode).toHaveBeenCalledTimes(3);
  });
});
