import { expect, onTestFinished, test, vi } from 'vitest';

import type { BootstrapProgress, ReadinessReporter } from '@/bootstrap/bootstrap-progress';
import { prepareProductResources } from '@/bootstrap/prepare-product-resources';

test('bounds required preparation without starting later optional tracks', async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  let resourceSignal: AbortSignal | undefined;
  const failed = vi.fn();
  const onFailure = vi.fn();
  const prefetchScenes = vi.fn(async () => undefined);
  const loading = prepareProductResources({
    bgmEnabled: false,
    prefetchScenes,
    loadModules: async () => undefined,
    prepareProductAudio: async () => undefined,
    prepareVisuals: (_report, signal) => {
      resourceSignal = signal;
      return new Promise(() => undefined);
    },
    onFailure,
  }).catch(failed);

  await vi.advanceTimersByTimeAsync(59_999);
  expect(failed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(failed).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'TimeoutError' }));
  expect(resourceSignal?.aborted).toBe(true);
  expect(onFailure).not.toHaveBeenCalled();
  expect(prefetchScenes.mock.calls).toEqual([[['lobby']]]);
  await loading;
  expect(vi.getTimerCount()).toBe(0);
});

test('external cancellation ends preparation without reporting an operational failure', async () => {
  const activity = new AbortController();
  let complete!: () => void;
  let resourceSignal: AbortSignal | undefined;
  const onFailure = vi.fn();
  const prefetchScenes = vi.fn(async () => undefined);
  const updates: BootstrapProgress[] = [];
  let report: ReadinessReporter = () => undefined;
  const loading = prepareProductResources({
    signal: activity.signal,
    bgmEnabled: false,
    prefetchScenes,
    loadModules: async () => undefined,
    prepareProductAudio: async () => undefined,
    prepareVisuals: (reportProgress, signal) => {
      report = reportProgress;
      resourceSignal = signal;
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
    onFailure,
    onProgress: (progress) => updates.push(progress),
  });
  const rejected = loading.catch((error: unknown) => error);
  activity.abort();
  expect(resourceSignal?.aborted).toBe(true);
  expect(await rejected).toBe(activity.signal.reason);
  const updateCount = updates.length;
  report('gpu', 1);
  complete();
  await Promise.resolve();
  expect(updates).toHaveLength(updateCount);
  expect(prefetchScenes.mock.calls).toEqual([[['lobby']]]);
  expect(onFailure).not.toHaveBeenCalled();
});

test('publishes completed gates and ignores late progress after a failed attempt', async () => {
  const updates: BootstrapProgress[] = [];
  let report: ReadinessReporter = () => undefined;
  let rejectPreparation!: (error: Error) => void;
  const loading = prepareProductResources({
    bgmEnabled: false,
    prefetchScenes: async () => undefined,
    loadModules: async () => undefined,
    prepareProductAudio: async () => undefined,
    prepareVisuals: (reportProgress) => {
      report = reportProgress;
      return new Promise((_resolve, reject) => {
        rejectPreparation = reject;
      });
    },
    onProgress: (value) => updates.push(value),
  });
  const failed = expect(loading).rejects.toThrow('GPU failed');
  await vi.waitFor(() => expect(updates.at(-1)?.progress).toBe(0.2));
  report('wasm', 1);
  expect(updates.at(-1)?.progress).toBe(0.4);
  rejectPreparation(new Error('GPU failed'));
  await failed;
  const count = updates.length;
  report('gpu', 1);
  expect(updates).toHaveLength(count);
});

test('disabled BGM still fetches every scene without blocking resource readiness', async () => {
  const scenes: string[] = [];
  await prepareProductResources({
    bgmEnabled: false,
    prefetchScenes: (requested) => {
      scenes.push(...requested);
      return new Promise(() => undefined);
    },
    loadModules: async () => undefined,
    prepareProductAudio: async () => undefined,
    prepareVisuals: async () => undefined,
  });
  expect(scenes).toEqual(['lobby', 'game', 'result']);
});

test('enabled Lobby failure blocks readiness while optional tracks do not', async () => {
  await expect(
    prepareProductResources({
      bgmEnabled: true,
      prefetchScenes: async (scenes) => {
        throw new Error(scenes[0]);
      },
      loadModules: async () => undefined,
      prepareProductAudio: async () => undefined,
      prepareVisuals: async () => undefined,
    }),
  ).rejects.toThrow('lobby');
});

test('dice preparation failure blocks readiness even with BGM disabled', async () => {
  await expect(
    prepareProductResources({
      bgmEnabled: false,
      prefetchScenes: async () => undefined,
      loadModules: async () => undefined,
      prepareProductAudio: async () => undefined,
      prepareVisuals: async () => {
        throw new Error('required dice preparation failed');
      },
    }),
  ).rejects.toThrow('required dice preparation failed');
});

test('product cues are required even with BGM disabled', async () => {
  await expect(
    prepareProductResources({
      bgmEnabled: false,
      prefetchScenes: async () => undefined,
      loadModules: async () => undefined,
      prepareVisuals: async () => undefined,
      prepareProductAudio: async () => {
        throw new Error('required cue preparation failed');
      },
    }),
  ).rejects.toThrow('required cue preparation failed');
});

test('reports the failed resource stage without replacing the original exception', async () => {
  const failure = new Error('PRIVATE resource URL');
  const onFailure = vi.fn();
  await expect(
    prepareProductResources({
      bgmEnabled: false,
      prefetchScenes: async () => undefined,
      loadModules: async () => undefined,
      prepareProductAudio: async () => {
        throw failure;
      },
      prepareVisuals: async () => undefined,
      onFailure,
    }),
  ).rejects.toBe(failure);
  expect(onFailure).toHaveBeenCalledExactlyOnceWith('audio', failure);
});

test.each([new TypeError('active failure'), new DOMException('active failure', 'TimeoutError')])(
  'preserves an active injected $name without mistaking it for the owned budget',
  async (failure) => {
    const onFailure = vi.fn();
    await expect(
      prepareProductResources({
        bgmEnabled: false,
        prefetchScenes: async () => undefined,
        loadModules: async () => {
          throw failure;
        },
        prepareProductAudio: async () => {
          throw new Error('later failure');
        },
        prepareVisuals: async () => undefined,
        onFailure,
      }),
    ).rejects.toBe(failure);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('modules', failure);
  },
);

test.each([true, false])(
  'defers optional music until required readiness with BGM %s',
  async (bgmEnabled) => {
    let completeVisuals!: () => void;
    let completeLobby!: () => void;
    const lobby = new Promise<void>((resolve) => {
      completeLobby = resolve;
    });
    const prefetchScenes = vi.fn((scenes: readonly string[]) =>
      scenes[0] === 'lobby' ? lobby : new Promise<void>(() => undefined),
    );
    const loading = prepareProductResources({
      bgmEnabled,
      prefetchScenes,
      loadModules: async () => undefined,
      prepareProductAudio: async () => undefined,
      prepareVisuals: () =>
        new Promise<void>((resolve) => {
          completeVisuals = resolve;
        }),
    });
    expect(prefetchScenes.mock.calls).toEqual([
      [['lobby'], ...(bgmEnabled ? [expect.any(AbortSignal)] : [])],
    ]);
    completeVisuals();
    if (bgmEnabled) {
      await Promise.resolve();
      expect(prefetchScenes).toHaveBeenCalledTimes(1);
      completeLobby();
    }
    await loading;
    expect(prefetchScenes.mock.calls.at(-1)).toEqual([['game', 'result']]);
    // Unresolved optional tracks, including disabled Lobby, do not delay readiness.
  },
);

test('optional music rejection after readiness does not fail preparation', async () => {
  const onFailure = vi.fn();
  await expect(
    prepareProductResources({
      bgmEnabled: true,
      prefetchScenes: async (scenes) => {
        if (scenes[0] === 'game') throw new Error('optional music unavailable');
      },
      loadModules: async () => undefined,
      prepareProductAudio: async () => undefined,
      prepareVisuals: async () => undefined,
      onFailure,
    }),
  ).resolves.toBeUndefined();
  expect(onFailure).not.toHaveBeenCalled();
});
