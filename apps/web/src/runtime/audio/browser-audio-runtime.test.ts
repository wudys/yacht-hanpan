import { afterEach, expect, test, vi } from 'vitest';
import { createActor, waitFor } from 'xstate';

import { appLifecycleMachine } from '@/app/app-lifecycle-machine';
import { prepareProductResources } from '@/bootstrap/prepare-product-resources';
import { createBrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { renderCueBuffers } from '@/runtime/audio/render-cue-buffers';

const toneHarness = vi.hoisted(() => {
  const order: string[] = [];
  const toneContext = {
    dispose: vi.fn(() => {
      order.push('dispose-tone-context');
    }),
  };
  return {
    getContext: vi.fn(() => toneContext),
    loadEagerToneIndex: vi.fn(() => {
      throw new Error('eager Tone index must not load');
    }),
    order,
    setContext: vi.fn(),
    toneContext,
  };
});

vi.mock('tone/build/esm/core/Global', () => ({
  getContext: toneHarness.getContext,
  setContext: toneHarness.setContext,
}));
vi.mock('@/runtime/audio/render-cue-buffers', () => ({
  renderCueBuffers: vi.fn(
    async () =>
      new Map([
        ['click', {}],
        ['success', {}],
      ]),
  ),
}));
vi.mock('tone', () => toneHarness.loadEagerToneIndex());

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

class FakeAudioContext {
  public static instances: FakeAudioContext[] = [];
  public readonly close: () => Promise<void> = vi.fn(() => {
    toneHarness.order.push('close-native-context');
    return Promise.resolve();
  });
  public readonly createMediaElementSource: ReturnType<typeof vi.fn> = vi.fn(() => ({
    connect: vi.fn(),
  }));
  public readonly createGain: ReturnType<typeof vi.fn> = vi.fn(() => ({
    gain: { value: 0 },
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  public readonly createBufferSource: ReturnType<typeof vi.fn> = vi.fn(() => ({
    buffer: null,
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
  }));
  public readonly destination: object = {};
  public readonly currentTime: number = 2;
  public readonly resume: () => Promise<void> = vi.fn(() => Promise.resolve());

  public constructor() {
    FakeAudioContext.instances.push(this);
  }
}

class FakeAudioElement {
  public static instances: FakeAudioElement[] = [];
  public currentTime: number = 0;
  public loop: boolean = false;
  public preload: string = '';
  public src: string = '';
  public readonly load: ReturnType<typeof vi.fn> = vi.fn();
  public readonly pause: ReturnType<typeof vi.fn> = vi.fn();
  public readonly play: ReturnType<typeof vi.fn<() => Promise<void>>> = vi.fn(() =>
    Promise.resolve(),
  );
  public readonly removeAttribute: ReturnType<typeof vi.fn> = vi.fn((name: string) => {
    if (name === 'src') this.src = '';
  });

  public constructor() {
    FakeAudioElement.instances.push(this);
  }
}

afterEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioElement.instances = [];
  toneHarness.getContext.mockClear();
  toneHarness.loadEagerToneIndex.mockClear();
  toneHarness.order.length = 0;
  toneHarness.setContext.mockClear();
  toneHarness.toneContext.dispose.mockClear();
  vi.unstubAllGlobals();
});

test('keeps product cues inert until their required preparation completes', () => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudioElement);
  const runtime = createBrowserAudioRuntime({ sfxEnabled: false });

  expect(() => runtime.playCue('roll.click')).not.toThrow();
  expect(() => runtime.setSfxEnabled(true)).not.toThrow();
  expect(toneHarness.setContext).not.toHaveBeenCalled();
});

test('prepares cues on the activated context and disposes the Tone wrapper last', async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudioElement);
  const runtime = createBrowserAudioRuntime();

  await expect(runtime.prepareCues()).rejects.toThrow('Audio runtime is not activated');
  expect(toneHarness.setContext).not.toHaveBeenCalled();
  await runtime.activate();
  expect(toneHarness.setContext).not.toHaveBeenCalled();
  await Promise.all([runtime.prepareCues(), runtime.prepareCues()]);

  expect(FakeAudioContext.instances).toHaveLength(1);
  expect(toneHarness.setContext).toHaveBeenCalledTimes(1);
  expect(toneHarness.setContext).toHaveBeenCalledWith(FakeAudioContext.instances[0]);
  expect(toneHarness.loadEagerToneIndex).not.toHaveBeenCalled();
  expect(vi.mocked(FakeAudioContext.instances[0]!.resume).mock.invocationCallOrder[0]).toBeLessThan(
    toneHarness.setContext.mock.invocationCallOrder[0] ?? 0,
  );
  runtime.playCue('roll.click');
  expect(FakeAudioContext.instances[0]?.createBufferSource).toHaveBeenCalledTimes(1);

  await runtime.dispose();
  expect(toneHarness.order.slice(-2)).toEqual(['close-native-context', 'dispose-tone-context']);
});

test('creates and activates one native audio context from duplicate starts', async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudioElement);
  const runtime = createBrowserAudioRuntime();

  const first = runtime.activate();
  const second = runtime.activate();

  expect(FakeAudioContext.instances).toHaveLength(1);
  await Promise.all([first, second]);
  expect(FakeAudioContext.instances[0]?.resume).toHaveBeenCalledTimes(1);
  expect(FakeAudioElement.instances[0]?.play).toHaveBeenCalledTimes(1);
  expect(FakeAudioElement.instances[0]?.removeAttribute).toHaveBeenCalledWith('src');

  await runtime.dispose();
  expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledTimes(1);
});

test('reports unsupported environments without constructing audio', async () => {
  vi.stubGlobal('AudioContext', undefined);
  vi.stubGlobal('webkitAudioContext', undefined);
  const runtime = createBrowserAudioRuntime();

  expect(runtime.supported).toBe(false);
  await expect(runtime.activate()).rejects.toThrow('Web Audio is unavailable');
  expect(FakeAudioContext.instances).toHaveLength(0);
});

test.each(['constructor', 'resume', 'cues'] as const)(
  'reports the original unexpected audio %s failure at its active owner once',
  async (stage) => {
    const cause = new TypeError(`${stage} invariant`);
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        public constructor() {
          super();
          if (stage === 'constructor') throw cause;
          if (stage === 'resume') vi.mocked(this.resume).mockRejectedValueOnce(cause);
        }
      },
    );
    vi.stubGlobal('Audio', FakeAudioElement);
    if (stage === 'cues') vi.mocked(renderCueBuffers).mockRejectedValueOnce(cause);
    const runtime = createBrowserAudioRuntime();
    const onUnexpected = vi.fn();
    const loadResources = vi.fn((_progress, signal: AbortSignal) =>
      prepareProductResources({
        signal,
        bgmEnabled: false,
        onFailure: (_stage, error) => onUnexpected(error),
        loadModules: () => Promise.resolve(),
        prepareProductAudio: runtime.prepareCues,
        prepareVisuals: () => Promise.resolve(),
        prefetchScenes: () => Promise.resolve(),
      }),
    );
    const actor = createActor(appLifecycleMachine, {
      input: {
        capabilities: { ok: true },
        activateAudio: runtime.activate,
        onUnexpected,
        loadResources,
      },
    }).start();
    actor.send({ type: 'BOOTSTRAP.START' });
    await waitFor(actor, (state) =>
      state.matches(stage === 'cues' ? 'resourceFailure' : 'activationFailure'),
    );
    expect(onUnexpected).toHaveBeenCalledExactlyOnceWith(cause);
    expect(loadResources).toHaveBeenCalledTimes(stage === 'cues' ? 1 : 0);
    actor.stop();
    await runtime.dispose();
  },
);

test('a denied silent media unlock does not fail activation or report an issue', async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal(
    'Audio',
    class extends FakeAudioElement {
      public constructor() {
        super();
        this.play.mockRejectedValueOnce(new DOMException('permission denied', 'NotAllowedError'));
      }
    },
  );
  const runtime = createBrowserAudioRuntime();
  const onUnexpected = vi.fn();
  const actor = createActor(appLifecycleMachine, {
    input: {
      capabilities: { ok: true },
      activateAudio: runtime.activate,
      onUnexpected,
      loadResources: () => Promise.resolve(),
    },
  }).start();
  actor.send({ type: 'BOOTSTRAP.START' });
  await waitFor(actor, (state) => state.matches('ready'));
  expect(onUnexpected).not.toHaveBeenCalled();
  actor.stop();
  await runtime.dispose();
});

test('propagates required prefetch failure and permits a fresh retry', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudioElement);
  vi.stubGlobal('fetch', fetch);
  const runtime = createBrowserAudioRuntime();

  await expect(runtime.prefetchScenes(['lobby'])).rejects.toThrow('offline');
  await expect(runtime.prefetchScenes(['lobby', 'lobby'])).resolves.toBeUndefined();

  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]?.[0]).toMatch(/\/audio\/bgm\/lobby\/[a-f0-9]{64}\.mp3$/u);
  expect(fetch.mock.calls[1]?.[0]).toBe(fetch.mock.calls[0]?.[0]);
  expect(fetch.mock.calls[1]?.[1]).toEqual({
    cache: 'force-cache',
    signal: expect.any(AbortSignal),
  });
});

test('deduplicates a successful scene prefetch across calls', async () => {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudioElement);
  vi.stubGlobal('fetch', fetch);
  const runtime = createBrowserAudioRuntime();

  await runtime.prefetchScenes(['game']);
  await runtime.prefetchScenes(['game']);

  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each(['headers', 'body'] as const)(
  'aborts prefetch during %s and preserves an immediate retry from late cleanup',
  async (phase) => {
    let requestSignal: AbortSignal | null | undefined;
    const bodyStarted = deferred();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce((_url, init) => {
      requestSignal = init?.signal;
      if (phase === 'headers') {
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
            once: true,
          });
        });
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              bodyStarted.resolve();
            },
            start(controller: ReadableStreamDefaultController<Uint8Array>) {
              requestSignal?.addEventListener(
                'abort',
                () => controller.error(requestSignal?.reason),
                { once: true },
              );
            },
          }),
        ),
      );
    });
    fetch.mockResolvedValueOnce(new Response('retry audio'));
    vi.stubGlobal('fetch', fetch);
    const runtime = createBrowserAudioRuntime();
    const owner = new AbortController();
    const first = runtime.prefetchScenes(['lobby'], owner.signal).catch((error: unknown) => error);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    if (phase === 'body') await bodyStarted.promise;
    owner.abort();
    expect(requestSignal?.aborted).toBe(true);
    const retry = runtime.prefetchScenes(['lobby']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await first).toMatchObject({ name: 'AbortError' });
    await retry;
    await runtime.prefetchScenes(['lobby']);
    expect(fetch).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  },
);

test('shares the first prefetch lifetime and detaches its owner after success', async () => {
  const body = deferred();
  let requestSignal: AbortSignal | null | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
    requestSignal = init?.signal;
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller: ReadableStreamDefaultController<Uint8Array>) {
            await body.promise;
            controller.close();
          },
        }),
      ),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const runtime = createBrowserAudioRuntime();
  const owner = new AbortController();
  const removeListener = vi.spyOn(owner.signal, 'removeEventListener');
  const laterCaller = new AbortController();
  const first = runtime.prefetchScenes(['game'], owner.signal);
  const second = runtime.prefetchScenes(['game'], laterCaller.signal);
  laterCaller.abort();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(requestSignal?.aborted).toBe(false);
  body.resolve();
  await Promise.all([first, second]);
  expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  owner.abort();
  expect(requestSignal?.aborted).toBe(false);
  await runtime.prefetchScenes(['game']);
  expect(fetch).toHaveBeenCalledTimes(1);
  await runtime.dispose();
});

test('disposal aborts optional prefetches without an external owner', async () => {
  let requestSignal: AbortSignal | null | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
          once: true,
        });
      });
    }),
  );
  const runtime = createBrowserAudioRuntime({ bgmEnabled: false });
  const pending = runtime.prefetchScenes(['result']).catch((error: unknown) => error);
  expect(requestSignal?.aborted).toBe(false);
  await runtime.dispose();
  expect(requestSignal?.aborted).toBe(true);
  expect(await pending).toMatchObject({ name: 'AbortError' });
});

test('skips an already aborted owner and detaches an active owner on disposal', async () => {
  let requestSignal: AbortSignal | null | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => {
    requestSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), {
        once: true,
      });
    });
  });
  vi.stubGlobal('fetch', fetch);
  const runtime = createBrowserAudioRuntime();
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(runtime.prefetchScenes(['lobby'], cancelled.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(fetch).not.toHaveBeenCalled();
  const owner = new AbortController();
  const removeListener = vi.spyOn(owner.signal, 'removeEventListener');
  const pending = runtime.prefetchScenes(['lobby'], owner.signal).catch((error: unknown) => error);
  await runtime.dispose();
  expect(requestSignal?.aborted).toBe(true);
  expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  expect(await pending).toMatchObject({ name: 'AbortError' });
});

test('uses one streaming element and does not restart an unchanged scene', async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudioElement);
  const runtime = createBrowserAudioRuntime();

  await runtime.activate();
  FakeAudioElement.instances[0]?.load.mockClear();
  FakeAudioElement.instances[0]?.pause.mockClear();
  FakeAudioElement.instances[0]?.play.mockClear();
  await runtime.setScene('lobby');
  await runtime.setScene('lobby');

  const media = FakeAudioElement.instances[0];
  expect(media).toBeDefined();
  expect(media?.src).toMatch(/\/audio\/bgm\/lobby\/[a-f0-9]{64}\.mp3$/u);
  expect(media?.loop).toBe(true);
  expect(media?.preload).toBe('metadata');
  expect(media?.load).toHaveBeenCalledTimes(1);
  expect(media?.play).toHaveBeenCalledTimes(1);

  await runtime.setScene('game');
  expect(media?.src).toMatch(/\/audio\/bgm\/game\/[a-f0-9]{64}\.mp3$/u);
  expect(media?.pause).toHaveBeenCalledTimes(1);
  expect(media?.load).toHaveBeenCalledTimes(2);
  expect(media?.play).toHaveBeenCalledTimes(2);

  await runtime.setScene(null);
  expect(media?.pause).toHaveBeenCalledTimes(2);
  expect(media?.src).toBe('');

  await runtime.dispose();
  expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledTimes(1);
});

test('keeps the scene silent when media playback is rejected', async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudioElement);
  const runtime = createBrowserAudioRuntime();
  await runtime.activate();
  FakeAudioElement.instances[0]?.play.mockRejectedValueOnce(new Error('blocked'));

  await expect(runtime.setScene('result')).resolves.toBeUndefined();
  expect(FakeAudioElement.instances[0]?.src).toMatch(/\/audio\/bgm\/result\/[a-f0-9]{64}\.mp3$/u);

  await expect(runtime.setScene('result')).resolves.toBeUndefined();
  expect(FakeAudioElement.instances[0]?.play).toHaveBeenCalledTimes(3);
});

test('stops while disabled and resumes the current scene when enabled', async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudioElement);
  const runtime = createBrowserAudioRuntime();
  await runtime.activate();
  const media = FakeAudioElement.instances[0];
  media?.play.mockClear();
  media?.pause.mockClear();

  await runtime.setScene('lobby');
  await runtime.setBgmEnabled(false);
  await runtime.setScene('game');

  expect(media?.play).toHaveBeenCalledTimes(1);
  expect(media?.pause).toHaveBeenCalledTimes(1);

  await runtime.setBgmEnabled(true);
  expect(media?.src).toMatch(/\/audio\/bgm\/game\/[a-f0-9]{64}\.mp3$/u);
  expect(media?.play).toHaveBeenCalledTimes(2);
});

test('keeps the newest scene when rapid playback requests settle out of order', async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudioElement);
  const runtime = createBrowserAudioRuntime();
  await runtime.activate();
  const media = FakeAudioElement.instances[0];
  const lobbyPlayback = deferred();
  const gamePlayback = deferred();
  media?.play.mockReset();
  media?.play
    .mockImplementationOnce(() => lobbyPlayback.promise)
    .mockImplementationOnce(() => gamePlayback.promise);

  const lobby = runtime.setScene('lobby');
  const game = runtime.setScene('game');
  gamePlayback.resolve();
  await game;
  lobbyPlayback.resolve();
  await lobby;
  await runtime.setScene('game');

  expect(media?.src).toMatch(/\/audio\/bgm\/game\/[a-f0-9]{64}\.mp3$/u);
  expect(media?.play).toHaveBeenCalledTimes(2);
});

test('only an explicit ON transition confirms once, OFF and hydration stay silent', async () => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Audio', FakeAudioElement);
  const runtime = createBrowserAudioRuntime({ sfxEnabled: false });
  await runtime.activate();
  await runtime.prepareCues();
  const context = FakeAudioContext.instances[0]!;
  runtime.setSfxEnabled(false);
  runtime.setSfxEnabled(true);
  expect(context.createBufferSource).not.toHaveBeenCalled();
  runtime.setSfxEnabled(false, true);
  expect(context.createBufferSource).not.toHaveBeenCalled();
  runtime.setSfxEnabled(true, true);
  runtime.setSfxEnabled(true);
  runtime.setSfxEnabled(true, true);
  expect(context.createBufferSource).toHaveBeenCalledTimes(1);
  runtime.setSfxEnabled(false, true);
  expect(context.createBufferSource.mock.results[0]?.value.stop).toHaveBeenCalledTimes(1);
  await runtime.dispose();
});
