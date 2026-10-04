import { expect, onTestFinished, test, vi } from 'vitest';

import type { BootstrapProgress, ReadinessReporter } from '@/bootstrap/bootstrap-progress';
import { loadProductResources } from '@/bootstrap/load-product-resources';

test('bounds required preparation and aborts its resources without canceling optional tracks', async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  let resourceSignal: AbortSignal | undefined;
  const failed = vi.fn();
  const onFailure = vi.fn();
  const prefetchScenes = vi.fn(async () => undefined);
  const loading = loadProductResources({
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
  expect(prefetchScenes.mock.calls).toEqual([[['lobby']], [['game', 'result']]]);
  await loading;
  expect(vi.getTimerCount()).toBe(0);
});

test('external cancellation ends preparation without reporting an operational failure', async () => {
  const activity = new AbortController();
  let complete!: () => void;
  let resourceSignal: AbortSignal | undefined;
  const onFailure = vi.fn();
  const loading = loadProductResources({
    signal: activity.signal,
    bgmEnabled: false,
    prefetchScenes: async () => undefined,
    loadModules: async () => undefined,
    prepareProductAudio: async () => undefined,
    prepareVisuals: (_report, signal) => {
      resourceSignal = signal;
      return new Promise<void>((resolve) => {
        complete = resolve;
      });
    },
    onFailure,
  });
  const rejected = loading.catch((error: unknown) => error);
  activity.abort();
  expect(resourceSignal?.aborted).toBe(true);
  expect(await rejected).toBe(activity.signal.reason);
  complete();
  expect(onFailure).not.toHaveBeenCalled();
});

test('publishes completed gates and ignores late progress after a failed attempt', async () => {
  const updates: BootstrapProgress[] = [];
  let report: ReadinessReporter = () => undefined;
  let rejectPreparation!: (error: Error) => void;
  const loading = loadProductResources({
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
  await loadProductResources({
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
    loadProductResources({
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
    loadProductResources({
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
    loadProductResources({
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
    loadProductResources({
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
      loadProductResources({
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
