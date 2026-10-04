import { requireGameAsset } from '@repo/game-assets';

import {
  type BootstrapProgress,
  createBootstrapProgress,
  type ReadinessReporter,
} from '@/bootstrap/bootstrap-progress';
import { VISUAL_ASSET_MANIFEST } from '@/bootstrap/preload-assets';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';

export type ResourceStage = 'modules' | 'audio' | 'dice' | 'bgm';

// One budget for required preparation, including response bodies and renderer warm-up.
const RESOURCE_PREPARATION_TIMEOUT_MS = 60_000;

export async function prepareProductResources(
  options: Readonly<{
    signal?: AbortSignal;
    bgmEnabled: boolean;
    prefetchScenes: BrowserAudioRuntime['prefetchScenes'];
    loadModules: () => Promise<unknown>;
    prepareProductAudio: () => Promise<void>;
    prepareVisuals: (report: ReadinessReporter, signal: AbortSignal) => Promise<unknown>;
    onProgress?: (progress: BootstrapProgress) => void;
    onFailure?: (stage: ResourceStage, error: unknown) => void;
  }>,
): Promise<void> {
  options.signal?.throwIfAborted();
  const preparation = new AbortController();
  let failureReported = false;
  function reportFailure(stage: ResourceStage, error: unknown) {
    if (failureReported) return;
    failureReported = true;
    try {
      options.onFailure?.(stage, error);
    } catch {
      /* Diagnostics never changes readiness. */
    }
  }
  const cancel = () => preparation.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(preparation.signal.reason);
    preparation.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timeout = setTimeout(() => {
    const error = new DOMException('Required resource preparation timed out', 'TimeoutError');
    preparation.abort(error);
  }, RESOURCE_PREPARATION_TIMEOUT_MS);
  const lobbyAudioBytes = options.bgmEnabled ? requireGameAsset('audio.bgm.lobby').bytes : 0;
  let active = true;
  const report = createBootstrapProgress({
    visualBytes: VISUAL_ASSET_MANIFEST.reduce((sum, entry) => sum + entry.bytes, 0),
    visualCount: VISUAL_ASSET_MANIFEST.length,
    lobbyAudioBytes,
    onProgress: (progress) => {
      if (active && !preparation.signal.aborted) options.onProgress?.(progress);
    },
  });
  const required = async (stage: ResourceStage, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      if (!preparation.signal.aborted) reportFailure(stage, error);
      throw error;
    }
  };
  try {
    const lobbyAudio = options.bgmEnabled
      ? required('bgm', () => options.prefetchScenes(['lobby'], preparation.signal))
      : options.prefetchScenes(['lobby']);
    if (!options.bgmEnabled) void lobbyAudio.catch(() => undefined);
    const ready = Promise.all([
      Promise.all([
        required('modules', options.loadModules),
        required('audio', options.prepareProductAudio),
      ]).then(() => report('modules', 1)),
      required('dice', () => options.prepareVisuals(report, preparation.signal)),
      options.bgmEnabled
        ? lobbyAudio.then(() => report('audio', lobbyAudioBytes))
        : Promise.resolve(),
    ]);
    await Promise.race([ready, aborted]);
    preparation.signal.throwIfAborted();
    void options.prefetchScenes(['game', 'result']).catch(() => undefined);
  } catch (error) {
    preparation.abort(error);
    throw error;
  } finally {
    active = false;
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
    preparation.signal.removeEventListener('abort', onAbort);
  }
}
