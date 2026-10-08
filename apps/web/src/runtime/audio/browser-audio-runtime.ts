import { requireGameAsset } from '@repo/game-assets';

import { createCueRuntime, PRODUCT_CUE, type ProductCue } from '@/runtime/audio/cue-runtime';

const SCENE_AUDIO_URL = {
  lobby: requireGameAsset('audio.bgm.lobby').url,
  game: requireGameAsset('audio.bgm.game').url,
  result: requireGameAsset('audio.bgm.result').url,
} as const;

export type ProductAudioScene = keyof typeof SCENE_AUDIO_URL;

const SILENT_UNLOCK_AUDIO_URL =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA';

export interface BrowserAudioRuntimeOptions {
  readonly bgmEnabled?: boolean;
  readonly sfxEnabled?: boolean;
}

export interface BrowserAudioRuntime {
  readonly supported: boolean;
  readonly activate: () => Promise<void>;
  readonly prepareCues: () => Promise<void>;
  readonly playCue: (cue: ProductCue) => void;
  /** The first request owns each shared scene prefetch until it settles. */
  readonly prefetchScenes: (
    scenes: readonly ProductAudioScene[],
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly setBgmEnabled: (enabled: boolean) => Promise<void>;
  readonly setScene: (scene: ProductAudioScene | null) => Promise<void>;
  readonly setSfxEnabled: (enabled: boolean, feedback?: boolean) => void;
  readonly stopCue: (cue?: ProductCue) => void;
  readonly dispose: () => Promise<void>;
}

export function createBrowserAudioRuntime(
  options: BrowserAudioRuntimeOptions = {},
): BrowserAudioRuntime {
  const AudioContextConstructor = resolveAudioContextConstructor();
  const AudioConstructor = globalThis.Audio;
  const cues = createCueRuntime({ enabled: options.sfxEnabled ?? true });
  const onVisibility = () => {
    if (globalThis.document?.hidden) cues.stop();
  };
  globalThis.document?.addEventListener('visibilitychange', onVisibility);
  let activation: Promise<void> | null = null;
  let context: AudioContext | null = null;
  let desiredScene: ProductAudioScene | null = null;
  let disposed = false;
  let enabled = options.bgmEnabled ?? true;
  let loadedScene: ProductAudioScene | null = null;
  let media: HTMLAudioElement | null = null;
  let operationVersion = 0;
  let pendingScene: ProductAudioScene | null = null;
  let playingScene: ProductAudioScene | null = null;
  const prefetches = new Map<
    ProductAudioScene,
    { request: Promise<void>; controller: AbortController; abort: () => void }
  >();

  const prefetchScene = (scene: ProductAudioScene, signal?: AbortSignal): Promise<void> => {
    if (disposed) return Promise.resolve();
    const existing = prefetches.get(scene);
    if (existing) return existing.request;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const url = SCENE_AUDIO_URL[scene];
    const controller = new AbortController();
    const abort = () => {
      if (prefetches.get(scene)?.controller === controller) prefetches.delete(scene);
      signal?.removeEventListener('abort', abort);
      controller.abort(signal?.reason);
    };
    const request = fetch(url, { cache: 'force-cache', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Scene BGM prefetch failed: ${scene}`);
        await response.arrayBuffer();
      })
      .catch((error: unknown) => {
        if (prefetches.get(scene)?.controller === controller) prefetches.delete(scene);
        throw error;
      })
      .finally(() => signal?.removeEventListener('abort', abort));
    const entry = { request, controller, abort };
    prefetches.set(scene, entry);
    signal?.addEventListener('abort', abort, { once: true });
    return request;
  };

  const playDesiredScene = (): Promise<void> => {
    const scene = desiredScene;
    const activeMedia = media;
    if (disposed || !enabled || scene === null || !activeMedia) return Promise.resolve();
    if (playingScene === scene || pendingScene === scene) return Promise.resolve();
    const url = SCENE_AUDIO_URL[scene];

    const hadPlayback = playingScene !== null || pendingScene !== null;
    const version = ++operationVersion;
    pendingScene = scene;
    if (loadedScene !== scene) {
      if (hadPlayback) activeMedia.pause();
      loadedScene = scene;
      playingScene = null;
      activeMedia.src = url;
      activeMedia.currentTime = 0;
      activeMedia.loop = true;
      activeMedia.preload = 'metadata';
      activeMedia.load();
    }

    return activeMedia
      .play()
      .then(
        () => {
          if (!disposed && version === operationVersion && enabled && desiredScene === scene) {
            playingScene = scene;
          }
        },
        () => {
          if (version === operationVersion) playingScene = null;
        },
      )
      .then(() => {
        if (version === operationVersion && pendingScene === scene) pendingScene = null;
      });
  };

  return {
    supported: AudioContextConstructor !== null && typeof AudioConstructor === 'function',
    activate() {
      if (disposed) return Promise.reject(new Error('Audio runtime is disposed'));
      if (AudioContextConstructor === null || typeof AudioConstructor !== 'function') {
        return Promise.reject(new Error('Web Audio is unavailable'));
      }
      context ??= new AudioContextConstructor();
      if (!media) {
        media = new AudioConstructor();
        media.volume = 0.2;
        context.createMediaElementSource(media).connect(context.destination);
        media.src = SILENT_UNLOCK_AUDIO_URL;
        media.preload = 'auto';
        void media
          .play()
          .catch(() => undefined)
          .then(() => {
            if (!media || desiredScene !== null) return;
            media.pause();
            media.currentTime = 0;
            media.removeAttribute('src');
            media.loop = true;
            media.preload = 'metadata';
          });
      }
      activation ??= context.resume().catch((error: unknown) => {
        activation = null;
        throw error;
      });
      return activation;
    },
    prepareCues() {
      if (disposed) return Promise.reject(new Error('Audio runtime is disposed'));
      if (!context) return Promise.reject(new Error('Audio runtime is not activated'));
      return cues.prepare(context);
    },
    playCue(cue: ProductCue) {
      cues.play(cue);
    },
    async prefetchScenes(scenes: readonly ProductAudioScene[], signal?: AbortSignal) {
      await Promise.all([...new Set(scenes)].map((scene) => prefetchScene(scene, signal)));
    },
    async setBgmEnabled(nextEnabled: boolean) {
      if (disposed || enabled === nextEnabled) return;
      enabled = nextEnabled;
      operationVersion += 1;
      pendingScene = null;
      playingScene = null;
      if (!enabled) {
        media?.pause();
        return;
      }
      await playDesiredScene();
    },
    async setScene(scene: ProductAudioScene | null) {
      if (
        disposed ||
        (desiredScene === scene &&
          (scene === null || playingScene === scene || pendingScene === scene))
      ) {
        return;
      }
      desiredScene = scene;
      if (scene === null) {
        operationVersion += 1;
        loadedScene = null;
        pendingScene = null;
        playingScene = null;
        if (media) {
          media.pause();
          media.currentTime = 0;
          media.removeAttribute('src');
        }
        return;
      }
      if (!enabled) return;
      await playDesiredScene();
    },
    stopCue: cues.stop,
    setSfxEnabled(nextEnabled: boolean, feedback: boolean = false) {
      const changed = cues.setEnabled(nextEnabled);
      if (changed && nextEnabled && feedback) cues.play(PRODUCT_CUE.SUCCESS);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      globalThis.document?.removeEventListener('visibilitychange', onVisibility);
      const pendingActivation = activation;
      const activeContext = context;
      const activeMedia = media;
      desiredScene = null;
      loadedScene = null;
      operationVersion += 1;
      pendingScene = null;
      playingScene = null;
      context = null;
      media = null;
      activation = null;
      for (const prefetch of prefetches.values()) prefetch.abort();
      prefetches.clear();
      activeMedia?.pause();
      activeMedia?.removeAttribute('src');
      try {
        await cues.dispose();
        await pendingActivation?.catch(() => undefined);
      } finally {
        try {
          await activeContext?.close();
        } finally {
          cues.disposeContext();
        }
      }
    },
  };
}

function resolveAudioContextConstructor(): typeof AudioContext | null {
  const browser = globalThis as typeof globalThis & {
    readonly webkitAudioContext?: typeof AudioContext;
  };
  return browser.AudioContext ?? browser.webkitAudioContext ?? null;
}
