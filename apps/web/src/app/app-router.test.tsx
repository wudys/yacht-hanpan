// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- memory-router actors can finish navigation after the runner's automatic cleanup. */

import { createGameClient } from '@repo/game-client-sdk';
import { RouterProvider } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type ActorRefFrom, createActor } from 'xstate';

import { appLifecycleMachine } from '@/app/app-lifecycle-machine';
import { createAppRouter } from '@/app/app-router';
import { CAPABILITY_FAILURE_CODE } from '@/bootstrap/static-capabilities';
import { LOCALE, translate } from '@/i18n';
import type { ProductAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { createRendererReadiness } from '@/runtime/dice/canvas/renderer-readiness';
import { createDicePresentation } from '@/runtime/dice/dice-presentation';
import { createProductPreferences } from '@/runtime/preferences/product-preferences';
import { createProductProfile } from '@/runtime/profile/product-profile';
import { createRoomAccess } from '@/runtime/room-access/room-access';
import { createStoredRoomRestore } from '@/runtime/room-access/stored-room-restore';
import { createBrowserSessionStore } from '@/runtime/session/browser-session-store';
import { createGameSessionHolder } from '@/runtime/session/session-holder';
import { createSessionRecovery } from '@/runtime/session/session-recovery';

const activeActors = new Set<ActorRefFrom<typeof appLifecycleMachine>>();

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

function createTestAudioRuntime(): ProductAudioRuntime {
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
  audio: ProductAudioRuntime = createTestAudioRuntime(),
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
  const store = createBrowserSessionStore();
  const client = createGameClient({
    serverUrl: 'http://localhost:3002',
    releaseId: 'app-test',
  });
  const preferences = createProductPreferences({ getItem: () => null, setItem: () => undefined });
  const sessions = createGameSessionHolder(client);
  const readiness = { wait: vi.fn(async () => ({ ok: true as const })) };
  const reentry = createStoredRoomRestore({ client, sessions, store, readiness });
  const recovery = createSessionRecovery({ sessions });
  const activity = new AbortController().signal;
  const access = createRoomAccess({
    activity,
    client,
    sessions,
    store,
    readiness,
    restore: reentry,
    recovery,
  });
  const router = createAppRouter({
    activity,
    access,
    audio,
    feedback: { observeCommand: () => {} },
    globalActor,
    profile: createProductProfile({ getItem: () => null, setItem: () => undefined }),
    preferences,
    renderer: createRendererReadiness(),
    clock: client.clock,
    sessions,
    store,
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
  return { ...view, audio, globalActor, router, preferences, readiness };
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
