// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- memory-router actors can finish navigation after the runner's automatic cleanup. */

import { createGameClient } from '@repo/game-client-sdk';
import { RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import type { WebGLRenderer } from 'three';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type ActorRefFrom, createActor } from 'xstate';

import { appLifecycleMachine } from '@/app/app-lifecycle-machine';
import { createAppRouter } from '@/app/app-router';
import { CAPABILITY_FAILURE_CODE } from '@/bootstrap/static-capabilities';
import { EntryScreen } from '@/features/entry/EntryScreen';
import GameScreen from '@/features/game/GameScreen';
import { LoadingScreen } from '@/features/loading/LoadingScreen';
import LobbyScreen from '@/features/lobby/LobbyScreen';
import { LOCALE, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import DiceCanvasHost from '@/runtime/dice/canvas/DiceCanvasHost';
import { createRendererReadiness as createReadiness } from '@/runtime/dice/canvas/renderer-readiness';
import { createDicePresentation } from '@/runtime/dice/dice-presentation';
import {
  createPreferencesStore,
  type PreferencesStorage,
} from '@/runtime/preferences/preferences-store';
import { createProfileSelectionStore } from '@/runtime/profile/profile-selection-store';
import { createRoomAccess } from '@/runtime/room-access/room-access';
import { createStoredRoomReentry } from '@/runtime/room-access/stored-room-reentry';
import { createGameSessionHolder } from '@/runtime/session/game-session-holder';
import { createSessionCredentialStore } from '@/runtime/session/session-credential-store';
import { createSessionRecovery } from '@/runtime/session/session-recovery';

const activeActors = new Set<ActorRefFrom<typeof appLifecycleMachine>>();
const canvasFixture = vi.hoisted(() => ({ rootCount: (): number => -1 }));

// Keep the Canvas host and R3F root real; replace only the unavailable jsdom GPU device.
vi.mock('@react-three/fiber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-three/fiber')>();
  canvasFixture.rootCount = () => actual._roots.size;
  return {
    ...actual,
    createRoot(canvas: HTMLCanvasElement) {
      const root = actual.createRoot(canvas);
      const configure = root.configure.bind(root);
      root.configure = (options) =>
        configure({
          ...options,
          gl: {
            render: vi.fn(),
            compile: vi.fn(),
            clear: vi.fn(),
            setPixelRatio: vi.fn(),
            setSize: vi.fn(),
            setClearAlpha: vi.fn(),
            shadowMap: {},
            xr: {
              isPresenting: false,
              addEventListener: vi.fn(),
              removeEventListener: vi.fn(),
              setAnimationLoop: vi.fn(),
            },
            renderLists: { dispose: vi.fn() },
            forceContextLoss: vi.fn(),
          } as unknown as WebGLRenderer,
        });
      return root;
    },
  };
});
vi.mock('@/runtime/dice/canvas/DiceCanvasHost', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/runtime/dice/canvas/DiceCanvasHost')>();
  return { ...actual, default: vi.fn(actual.default) };
});

vi.mock('@/features/entry/EntryScreen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/entry/EntryScreen')>();
  return { ...actual, EntryScreen: vi.fn(actual.EntryScreen) };
});
vi.mock('@/features/loading/LoadingScreen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/loading/LoadingScreen')>();
  return { ...actual, LoadingScreen: vi.fn(actual.LoadingScreen) };
});
vi.mock('@/features/lobby/LobbyScreen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/lobby/LobbyScreen')>();
  return { ...actual, default: vi.fn(actual.default) };
});
vi.mock('@/features/game/GameScreen', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/game/GameScreen')>();
  return { ...actual, default: vi.fn(actual.default) };
});

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('scrollTo', vi.fn());
  Object.defineProperty(document, 'startViewTransition', {
    configurable: true,
    value: vi.fn((update: () => void | Promise<void>) => {
      const updateCallbackDone = Promise.resolve().then(update);
      return {
        ready: Promise.resolve(),
        updateCallbackDone,
        finished: updateCallbackDone,
        skipTransition: vi.fn(),
      };
    }),
  });
});

afterEach(() => {
  cleanup();
  for (const actor of activeActors) actor.stop();
  activeActors.clear();
  vi.unstubAllGlobals();
});

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolveDeferred!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function stubAnimationFrames() {
  let nextHandle = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const handle = (nextHandle += 1);
    callbacks.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    callbacks.delete(handle);
  });
  return {
    pending: () => callbacks.size,
    flush: () => {
      const frameCallbacks = [...callbacks.values()];
      callbacks.clear();
      act(() => {
        for (const callback of frameCallbacks) callback(performance.now());
      });
    },
  };
}

function createTestAudioRuntime(): BrowserAudioRuntime {
  return {
    supported: true,
    activate: vi.fn(() => Promise.resolve()),
    prepareCues: vi.fn(() => Promise.resolve()),
    playCue: vi.fn(),
    setSfxEnabled: vi.fn(),
    stopCue: vi.fn(),
    prefetchScenes: vi.fn(() => Promise.resolve()),
    setBgmEnabled: vi.fn(() => Promise.resolve()),
    setScene: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(() => Promise.resolve()),
  };
}

function renderApp(
  loadResources: () => Promise<void> = () => Promise.resolve(),
  audio: BrowserAudioRuntime = createTestAudioRuntime(),
  preferenceStorage: PreferencesStorage = {
    getItem: () => null,
    setItem: () => undefined,
  },
) {
  const globalActor = createActor(appLifecycleMachine, {
    input: {
      capabilities: audio.supported
        ? { ok: true }
        : { ok: false, code: CAPABILITY_FAILURE_CODE.WEB_AUDIO_UNAVAILABLE },
      activateAudio: audio.activate,
      loadResources,
    },
  });
  globalActor.start();
  activeActors.add(globalActor);
  const sessionCredentialStore = createSessionCredentialStore();
  const client = createGameClient({
    serverUrl: 'http://localhost:3002',
    releaseId: 'app-test',
  });
  const preferences = createPreferencesStore(preferenceStorage);
  const sessions = createGameSessionHolder(client);
  const readiness = { wait: vi.fn(async () => ({ ok: true as const })) };
  const reentry = createStoredRoomReentry({ client, sessions, sessionCredentialStore, readiness });
  const recovery = createSessionRecovery({ sessions });
  const activity = new AbortController().signal;
  const access = createRoomAccess({
    activity,
    client,
    sessions,
    sessionCredentialStore,
    readiness,
    reentry,
    recovery,
  });
  const renderer = createReadiness();
  const profile = createProfileSelectionStore({ getItem: () => null, setItem: () => undefined });
  profile.initialize();
  const router = createAppRouter({
    activity,
    access,
    audio,
    feedback: { observeCommand: () => {} },
    globalActor,
    profile,
    preferences,
    renderer,
    clock: client.clock,
    sessions,
    sessionCredentialStore,
    recovery,
    presentation: createDicePresentation({
      sessions,
      requestSynchronization: recovery.requestSynchronization,
      requireRefreshAfterSynchronization: recovery.requireRefreshAfterSynchronization,
      playCue: audio.playCue,
    }),
  });
  const view = render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  return { ...view, audio, globalActor, router, preferences, readiness, renderer };
}

test('does not wake the server during Entry, Loading or an idle Lobby', async () => {
  const loading = deferred();
  const { readiness } = renderApp(() => loading.promise);
  const start = await screen.findByRole('button', { name: '게임 시작' });
  expect(readiness.wait).not.toHaveBeenCalled();
  fireEvent.click(start, { detail: 1 });
  expect(await screen.findByText('게임 불러오는 중')).not.toBeNull();
  expect(readiness.wait).not.toHaveBeenCalled();
  loading.resolve();
  expect(await screen.findByRole('heading', { name: '로비' })).not.toBeNull();
  expect(readiness.wait).not.toHaveBeenCalled();
});

test('presents completed readiness for a paint before navigating to Lobby', async () => {
  const frames = stubAnimationFrames();
  const loading = deferred();
  const { globalActor, router } = renderApp(() => loading.promise);
  fireEvent.click(await screen.findByRole('button', { name: '게임 시작' }), { detail: 1 });
  expect(await screen.findByText('게임 불러오는 중')).not.toBeNull();

  await act(async () => {
    loading.resolve();
    await loading.promise;
  });
  await vi.waitFor(() => expect(globalActor.getSnapshot().matches('ready')).toBe(true));
  expect(screen.getByText('100%')).not.toBeNull();
  expect(router.state.location.pathname).toBe('/loading');
  expect(frames.pending()).toBe(1);

  frames.flush();
  expect(screen.getByText('100%')).not.toBeNull();
  expect(router.state.location.pathname).toBe('/loading');
  expect(frames.pending()).toBe(1);

  await act(async () => frames.flush());
  expect(screen.getByText('100%')).not.toBeNull();
  expect(router.state.location.pathname).toBe('/loading');
  expect(await screen.findByRole('heading', { name: '로비' })).not.toBeNull();
});

test('cancels a pending completed-loading navigation when the app unmounts', async () => {
  const frames = stubAnimationFrames();
  const loading = deferred();
  const { globalActor, router, unmount } = renderApp(() => loading.promise);
  fireEvent.click(await screen.findByRole('button', { name: '게임 시작' }), { detail: 1 });
  expect(await screen.findByText('게임 불러오는 중')).not.toBeNull();

  await act(async () => {
    loading.resolve();
    await loading.promise;
  });
  await vi.waitFor(() => expect(globalActor.getSnapshot().matches('ready')).toBe(true));
  expect(frames.pending()).toBe(1);
  frames.flush();
  expect(frames.pending()).toBe(1);

  frames.flush();
  unmount();
  expect(frames.pending()).toBe(0);
  frames.flush();
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(router.state.location.pathname).toBe('/loading');
});

test('updates current route copy when the shared locale preference changes', async () => {
  const { preferences } = renderApp();
  expect(await screen.findByRole('button', { name: '게임 시작' })).not.toBeNull();
  act(() => {
    preferences.setLocale('en');
  });
  expect(
    await screen.findByRole('button', { name: translate(LOCALE.EN, 'app.startAction') }),
  ).not.toBeNull();
});

test.each([
  ['/entry', EntryScreen],
  ['/loading', LoadingScreen],
  ['/lobby', LobbyScreen],
  ['/game', GameScreen],
] as const)(
  'only re-renders the %s screen for a locale preference change',
  async (path, routeScreen) => {
    let storageAvailable = true;
    const { router, preferences } = renderApp(undefined, undefined, {
      getItem: () => null,
      setItem: () => {
        if (!storageAvailable) throw new Error('storage blocked');
      },
    });
    await screen.findByRole('button', { name: '게임 시작' });
    await act(async () => {
      await router.navigate({ to: path });
    });
    await vi.waitFor(() => expect(vi.mocked(routeScreen).mock.lastCall?.[0].locale).toBe('ko'));
    await act(async () => undefined);
    const executionCount = () => vi.mocked(routeScreen).mock.calls.length;
    const initialRenders = executionCount();
    act(() => {
      preferences.setBgmEnabled(false);
    });
    const bgmRenders = executionCount() - initialRenders;
    const beforeSfx = executionCount();
    act(() => {
      preferences.setSfxEnabled(false);
    });
    const sfxRenders = executionCount() - beforeSfx;
    const beforeFailure = executionCount();
    storageAvailable = false;
    act(() => {
      preferences.setLocale('ko');
    });
    expect(preferences.getSnapshot().storageFailed).toBe(true);
    const failureRenders = executionCount() - beforeFailure;
    const beforeRecovery = executionCount();
    storageAvailable = true;
    act(() => {
      preferences.setLocale('ko');
    });
    expect(preferences.getSnapshot().storageFailed).toBe(false);
    const recoveryRenders = executionCount() - beforeRecovery;
    const beforeLocale = executionCount();
    act(() => {
      preferences.setLocale('en');
    });
    expect(vi.mocked(routeScreen).mock.lastCall?.[0].locale).toBe('en');
    const localeRenders = executionCount() - beforeLocale;
    expect({ bgmRenders, sfxRenders, failureRenders, recoveryRenders }).toEqual({
      bgmRenders: 0,
      sfxRenders: 0,
      failureRenders: 0,
      recoveryRenders: 0,
    });
    expect(localeRenders).toBeGreaterThan(0);
  },
);

test('keeps preference changes outside the persistent Canvas React tree and existing R3F root', async () => {
  let storageAvailable = true;
  const { preferences, renderer } = renderApp(undefined, undefined, {
    getItem: () => null,
    setItem: () => {
      if (!storageAvailable) throw new Error('storage blocked');
    },
  });
  await screen.findByRole('button', { name: '게임 시작' });
  act(() => {
    void renderer.prepare();
  });
  const canvas = await screen.findByTestId('dice-canvas');
  await vi.waitFor(() => expect(canvasFixture.rootCount()).toBe(1));
  await act(async () => undefined);
  const initialRenders = vi.mocked(DiceCanvasHost).mock.calls.length;
  act(() => {
    preferences.setBgmEnabled(false);
  });
  act(() => {
    preferences.setSfxEnabled(false);
  });
  act(() => {
    preferences.setLocale('en');
  });
  storageAvailable = false;
  act(() => {
    preferences.setLocale('en');
  });
  expect(preferences.getSnapshot().storageFailed).toBe(true);
  storageAvailable = true;
  act(() => {
    preferences.setLocale('en');
  });
  expect(preferences.getSnapshot().storageFailed).toBe(false);
  expect(screen.getByTestId('dice-canvas')).toBe(canvas);
  expect(canvasFixture.rootCount()).toBe(1);
  expect(vi.mocked(DiceCanvasHost).mock.calls.length - initialRenders).toBe(0);
});

test('applies independent BGM and SFX preferences to the existing audio runtime', async () => {
  const { preferences, audio } = renderApp();
  expect(await screen.findByRole('button', { name: '게임 시작' })).not.toBeNull();
  act(() => {
    preferences.setBgmEnabled(false);
  });
  expect(audio.setBgmEnabled).toHaveBeenLastCalledWith(false);
  act(() => {
    preferences.setBgmEnabled(true);
  });
  expect(audio.setBgmEnabled).toHaveBeenLastCalledWith(true);
  act(() => {
    preferences.setSfxEnabled(false);
  });
  expect(audio.setSfxEnabled).toHaveBeenLastCalledWith(false);
  expect(audio.setBgmEnabled).toHaveBeenLastCalledWith(true);
  act(() => {
    preferences.setSfxEnabled(true);
  });
  expect(audio.setSfxEnabled).toHaveBeenLastCalledWith(true);
});

test('uses memory routing without changing the browser URL', async () => {
  const { router } = renderApp();

  expect(await screen.findByRole('heading', { name: '요트 한판' })).not.toBeNull();
  expect(router.state.location.pathname).toBe('/entry');
  expect(window.location.pathname).toBe('/');
  expect(screen.getByTestId('global-layer-host')).not.toBeNull();
});

test('requests a same-document view transition when starting loading', async () => {
  const loading = deferred();
  renderApp(() => loading.promise);

  fireEvent.click(await screen.findByRole('button', { name: '게임 시작' }), { detail: 1 });
  expect(await screen.findByText('게임 불러오는 중')).not.toBeNull();

  expect(document.startViewTransition).toHaveBeenCalledOnce();
  loading.resolve();
});

test('keeps the root frame mounted across entry, loading and lobby routes', async () => {
  const loading = deferred();
  renderApp(() => loading.promise);

  expect(await screen.findByRole('heading', { name: '요트 한판' })).not.toBeNull();

  // The wrapper intentionally has no semantic role; identity across transitions is the contract.
  // eslint-disable-next-line testing-library/no-node-access
  const frame = document.querySelector('[data-game-ui-root="true"]');
  expect(frame).not.toBeNull();

  fireEvent.click(await screen.findByRole('button', { name: '게임 시작' }), { detail: 1 });
  expect(await screen.findByText('게임 불러오는 중')).not.toBeNull();

  loading.resolve();
  expect(await screen.findByRole('heading', { name: '로비' })).not.toBeNull();
  // eslint-disable-next-line testing-library/no-node-access
  expect(document.querySelector('[data-game-ui-root="true"]')).toBe(frame);
  expect(window.location.pathname).toBe('/');
});

test('lets Loading own offline feedback before retaining Lobby behind the global failure', async () => {
  const loading = deferred();
  const { globalActor } = renderApp(() => loading.promise);
  fireEvent.click(await screen.findByRole('button', { name: '게임 시작' }), { detail: 1 });
  expect(await screen.findByText('게임 불러오는 중')).not.toBeNull();
  act(() => globalActor.send({ type: 'NETWORK.CHANGED', status: 'offline' }));
  const globalLayers = within(screen.getByTestId('global-layer-host'));
  expect(globalLayers.queryByRole('status')).toBeNull();
  expect(globalLayers.queryByRole('alertdialog')).toBeNull();

  loading.resolve();
  const lobbyHeading = await screen.findByText('로비');
  const interactionSurface = screen.getByTestId('global-interaction-surface');
  expect(within(interactionSurface).getByText('로비')).toBe(lobbyHeading);
  expect(globalLayers.getByRole('alertdialog').getAttribute('data-global-failure')).toBe('offline');
  expect(interactionSurface.getAttribute('aria-hidden')).toBe('true');

  act(() => globalActor.send({ type: 'NETWORK.CHANGED', status: 'online' }));
  expect(globalLayers.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByRole('heading', { name: '로비' })).toBe(lobbyHeading);
  expect(interactionSurface.getAttribute('aria-hidden')).toBeNull();
});

test('keeps Entry visible until trusted pointer activation succeeds', async () => {
  const loading = deferred();
  const activation = deferred();
  const audio = { ...createTestAudioRuntime(), activate: () => activation.promise };
  const { router } = renderApp(() => loading.promise, audio);
  const start = await screen.findByRole('button', { name: '게임 시작' });
  fireEvent.click(start, { detail: 0 });
  expect(router.state.location.pathname).toBe('/entry');
  fireEvent.click(start, { detail: 1 });
  expect(router.state.location.pathname).toBe('/entry');
  activation.resolve();
  expect(await screen.findByText('게임 불러오는 중')).not.toBeNull();
  loading.resolve();
});
