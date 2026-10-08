// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { AppRouterContext } from '@/app/app-router';
import type { prepareProductResources } from '@/bootstrap/prepare-product-resources';
import type { ProductVisualPreparation } from '@/bootstrap/product-visual-preparation';
import { inactiveTelemetry } from '@/runtime/telemetry/telemetry';

const fixture = vi.hoisted(() => ({
  replaced: false,
  sessionListeners: new Set<() => void>(),
  audioDispose: vi.fn(async () => undefined),
  presentationDispose: vi.fn(),
  storeInitialize: vi.fn(),
  render: vi.fn(),
  unmount: vi.fn(),
  router: vi.fn<(context: AppRouterContext) => unknown>(),
  loadResources: vi.fn<typeof prepareProductResources>(),
  prepareVisuals: vi.fn<ProductVisualPreparation['prepare']>(),
  disposeVisuals: vi.fn<ProductVisualPreparation['dispose']>(),
  trackEvent: vi.fn(),
  reportUnexpected: vi.fn(),
  stopTelemetry: vi.fn(),
  unsubscribeReplacement: vi.fn(),
  unsubscribeConnectivity: vi.fn(),
  unsubscribeRenderer: vi.fn(),
}));

vi.mock('@repo/game-client-sdk', () => ({ createGameClient: () => ({ clock: {} }) }));
vi.mock('react-dom/client', () => ({
  createRoot: () => ({ render: fixture.render, unmount: fixture.unmount }),
}));
vi.mock('@/bootstrap/web-config', () => ({
  parseWebConfig: () => ({ gameServerUrl: 'https://game.example.com', releaseId: 'release' }),
}));
vi.mock('@/bootstrap/static-capabilities', () => ({
  detectStaticGameplayCapabilities: () => ({ ok: true, missing: [] }),
}));
vi.mock('@/bootstrap/prepare-product-resources', () => ({
  prepareProductResources: fixture.loadResources,
}));
vi.mock('@/bootstrap/product-visual-preparation', async () => {
  const { createRendererReadiness: createReadiness } =
    await import('@/runtime/dice/canvas/renderer-readiness');
  return {
    createProductVisualPreparation: () => {
      const renderer = createReadiness();
      const { subscribe } = renderer;
      renderer.subscribe = (listener) => {
        const unsubscribe = subscribe(listener);
        return () => {
          unsubscribe();
          fixture.unsubscribeRenderer();
        };
      };
      fixture.disposeVisuals.mockImplementation(async () => renderer.dispose());
      return { renderer, prepare: fixture.prepareVisuals, dispose: fixture.disposeVisuals };
    },
  };
});
vi.mock('@/app/app-router', () => ({ createAppRouter: fixture.router }));
vi.mock('@/runtime/audio/browser-audio-runtime', () => ({
  createBrowserAudioRuntime: () => ({
    supported: true,
    activate: async () => undefined,
    prefetchScenes: async () => undefined,
    prepareCues: async () => undefined,
    playCue: vi.fn(),
    setSurfaceExposed: vi.fn(),
    dispose: fixture.audioDispose,
  }),
}));
vi.mock('@/runtime/audio/game-audio-feedback', () => ({
  startGameAudioFeedback: () => ({ dispose: vi.fn(), setSurfaceExposed: vi.fn() }),
}));
vi.mock('@/runtime/dice/dice-presentation', () => ({
  createDicePresentation: () => ({ start: vi.fn(), dispose: fixture.presentationDispose }),
}));
vi.mock('@/runtime/network/server-readiness', () => ({ createServerReadiness: () => ({}) }));
vi.mock('@/runtime/room-access/room-access', () => ({
  createRoomAccess: () => ({ dispose: vi.fn() }),
}));
vi.mock('@/runtime/room-access/stored-room-reentry', () => ({
  createStoredRoomReentry: () => ({ dispose: vi.fn() }),
}));
vi.mock('@/runtime/session/session-credential-store', () => ({
  createSessionCredentialStore: () => ({ initialize: fixture.storeInitialize }),
}));
vi.mock('@/runtime/session/game-session-holder', () => ({
  createGameSessionHolder: () => ({
    getSnapshot: () => ({
      session: null,
      sessionSnapshot: fixture.replaced ? { connection: 'replaced' } : null,
    }),
    subscribe: (listener: () => void) => {
      fixture.sessionListeners.add(listener);
      return () => {
        fixture.sessionListeners.delete(listener);
        fixture.unsubscribeReplacement();
      };
    },
    dispose: vi.fn(),
  }),
}));
vi.mock('@/runtime/session/session-recovery', () => ({
  createSessionRecovery: () => ({ start: vi.fn(), dispose: vi.fn() }),
}));
vi.mock('@/runtime/telemetry/session-telemetry-observer', () => ({
  observeSessionTelemetry: () => fixture.stopTelemetry,
}));
vi.mock('@/runtime/network/browser-connectivity', () => ({
  subscribeBrowserConnectivity: () => fixture.unsubscribeConnectivity,
}));

let disposeApp: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.replaced = false;
  fixture.sessionListeners.clear();
  fixture.router.mockImplementation(() => ({}));
  fixture.loadResources.mockImplementation(async () => undefined);
  fixture.prepareVisuals.mockImplementation(async () => undefined);
  fixture.stopTelemetry.mockImplementation(() => undefined);
  fixture.unsubscribeReplacement.mockImplementation(() => undefined);
  fixture.unsubscribeConnectivity.mockImplementation(() => undefined);
  fixture.unsubscribeRenderer.mockImplementation(() => undefined);
  fixture.reportUnexpected.mockImplementation(() => undefined);
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  disposeApp?.();
  disposeApp = undefined;
});

async function start() {
  const { startWebApp } = await import('@/app/start-web-app');
  disposeApp = startWebApp({
    ...inactiveTelemetry,
    trackEvent: fixture.trackEvent,
    reportUnexpected: fixture.reportUnexpected,
  });
  const context = fixture.router.mock.calls[0]?.[0];
  if (!context) throw new Error('Product router was not assembled');
  return context;
}

function replaceSession() {
  fixture.replaced = true;
  for (const listener of fixture.sessionListeners) listener();
}

test('keeps the replacement shell alive, ignores late bootstrap success, and disposes the app once', async () => {
  let complete!: () => void;
  fixture.loadResources.mockImplementation(
    () => new Promise<void>((resolve) => (complete = resolve)),
  );
  const context = await start();
  const disposeRenderer = vi.spyOn(context.renderer, 'dispose');
  context.globalActor.send({ type: 'BOOTSTRAP.START' });
  await vi.waitFor(() => expect(fixture.loadResources).toHaveBeenCalledOnce());

  replaceSession();

  expect(context.activity.aborted).toBe(true);
  expect(context.globalActor.getSnapshot().matches('replaced')).toBe(true);
  expect(fixture.presentationDispose).toHaveBeenCalledOnce();
  expect(fixture.audioDispose).toHaveBeenCalledOnce();
  expect(fixture.render).toHaveBeenCalledOnce();
  expect(fixture.unmount).not.toHaveBeenCalled();
  expect(disposeRenderer).not.toHaveBeenCalled();

  complete();
  await fixture.loadResources.mock.results[0]?.value;
  await Promise.resolve();
  expect(fixture.storeInitialize).not.toHaveBeenCalled();
  expect(fixture.trackEvent).not.toHaveBeenCalled();
  expect(context.globalActor.getSnapshot().matches('replaced')).toBe(true);

  disposeApp?.();
  disposeApp?.();
  expect(fixture.audioDispose).toHaveBeenCalledOnce();
  expect(fixture.presentationDispose).toHaveBeenCalledOnce();
  expect(disposeRenderer).toHaveBeenCalledOnce();
  expect(fixture.unmount).toHaveBeenCalledOnce();
  expect(fixture.sessionListeners.size).toBe(0);
});

test('wires visual preparation and prevents final disposal from applying late bootstrap success', async () => {
  let complete!: () => void;
  fixture.prepareVisuals.mockImplementation(
    () => new Promise<void>((resolve) => (complete = resolve)),
  );
  fixture.loadResources.mockImplementation(async ({ prepareVisuals, signal }) => {
    await prepareVisuals(vi.fn(), signal!);
  });
  const context = await start();
  context.globalActor.send({ type: 'BOOTSTRAP.START' });
  await vi.waitFor(() => expect(fixture.prepareVisuals).toHaveBeenCalledOnce());

  disposeApp?.();
  expect(context.activity.aborted).toBe(true);
  expect(fixture.unmount.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.disposeVisuals.mock.invocationCallOrder[0]!,
  );
  complete();
  await fixture.loadResources.mock.results[0]?.value;
  await Promise.resolve();
  expect(fixture.storeInitialize).not.toHaveBeenCalled();
  expect(fixture.trackEvent).not.toHaveBeenCalled();
  disposeApp?.();
  expect(fixture.disposeVisuals).toHaveBeenCalledOnce();
});

test('releases execution and app owners when router assembly fails', async () => {
  const failure = new Error('router assembly failed');
  let disposeRenderer: ReturnType<typeof vi.spyOn> | undefined;
  fixture.router.mockImplementationOnce(({ renderer }) => {
    disposeRenderer = vi.spyOn(renderer, 'dispose');
    throw failure;
  });
  const { startWebApp } = await import('@/app/start-web-app');

  expect(() => startWebApp(inactiveTelemetry)).toThrow(failure);

  expect(fixture.audioDispose).toHaveBeenCalledOnce();
  expect(fixture.presentationDispose).toHaveBeenCalledOnce();
  expect(disposeRenderer).toHaveBeenCalledOnce();
  expect(fixture.sessionListeners.size).toBe(0);
  expect(fixture.render).not.toHaveBeenCalled();
});

test('cleans up actor, Canvas consumers, and visual ownership after React render fails', async () => {
  const failure = new Error('React rendering failed');
  fixture.render.mockImplementationOnce(() => {
    throw failure;
  });
  const { startWebApp } = await import('@/app/start-web-app');
  expect(() => startWebApp(inactiveTelemetry)).toThrow(failure);
  expect(fixture.audioDispose).toHaveBeenCalledOnce();
  expect(fixture.presentationDispose).toHaveBeenCalledOnce();
  expect(fixture.unmount).toHaveBeenCalledOnce();
  expect(fixture.disposeVisuals).toHaveBeenCalledOnce();
  expect(fixture.unmount.mock.invocationCallOrder[0]).toBeLessThan(
    fixture.disposeVisuals.mock.invocationCallOrder[0]!,
  );
  expect(fixture.sessionListeners.size).toBe(0);
});

test.each(['telemetry', 'replacement', 'connectivity', 'renderer', 'actor', 'react'] as const)(
  'continues final cleanup when %s teardown throws and diagnostics fail',
  async (owner) => {
    const context = await start();
    const stopActor = context.globalActor.stop.bind(context.globalActor);
    const actorStop = vi.spyOn(context.globalActor, 'stop');
    const dispose = {
      telemetry: fixture.stopTelemetry,
      replacement: fixture.unsubscribeReplacement,
      connectivity: fixture.unsubscribeConnectivity,
      renderer: fixture.unsubscribeRenderer,
      actor: actorStop,
      react: fixture.unmount,
    }[owner];
    const failure = new Error(`${owner} teardown failed`);
    dispose.mockImplementationOnce(() => {
      if (owner === 'actor') stopActor();
      disposeApp?.();
      throw failure;
    });
    fixture.reportUnexpected.mockImplementationOnce(() => {
      throw new Error('telemetry failed');
    });

    expect(disposeApp).not.toThrow();
    disposeApp?.();

    expect(context.activity.aborted).toBe(true);
    expect(fixture.stopTelemetry).toHaveBeenCalledOnce();
    expect(fixture.unsubscribeReplacement).toHaveBeenCalledOnce();
    expect(fixture.unsubscribeConnectivity).toHaveBeenCalledOnce();
    expect(fixture.unsubscribeRenderer).toHaveBeenCalledOnce();
    expect(actorStop).toHaveBeenCalledOnce();
    expect(fixture.unmount).toHaveBeenCalledOnce();
    expect(fixture.disposeVisuals).toHaveBeenCalledOnce();
    expect(fixture.reportUnexpected).toHaveBeenCalledExactlyOnceWith(failure);
    expect(fixture.sessionListeners.size).toBe(0);
    expect(fixture.stopTelemetry.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.unsubscribeReplacement.mock.invocationCallOrder[0]!,
    );
    expect(fixture.unsubscribeReplacement.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.unsubscribeConnectivity.mock.invocationCallOrder[0]!,
    );
    expect(fixture.unsubscribeConnectivity.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.unsubscribeRenderer.mock.invocationCallOrder[0]!,
    );
    expect(fixture.unsubscribeRenderer.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.audioDispose.mock.invocationCallOrder[0]!,
    );
    expect(fixture.audioDispose.mock.invocationCallOrder[0]).toBeLessThan(
      actorStop.mock.invocationCallOrder[0]!,
    );
    expect(actorStop.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.unmount.mock.invocationCallOrder[0]!,
    );
    expect(fixture.unmount.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.disposeVisuals.mock.invocationCallOrder[0]!,
    );
  },
);

test.each(['throw', 'reject'] as const)(
  'accepts visual dispose %s and reports the original cause once',
  async (kind) => {
    const failure = new Error('visual disposal failed');
    const context = await start();
    if (kind === 'throw')
      fixture.disposeVisuals.mockImplementationOnce(() => {
        throw failure;
      });
    else fixture.disposeVisuals.mockRejectedValueOnce(failure);
    fixture.reportUnexpected.mockImplementationOnce(() => {
      throw new Error('telemetry failed');
    });

    expect(disposeApp?.()).toBeUndefined();
    disposeApp?.();

    expect(context.activity.aborted).toBe(true);
    await vi.waitFor(() =>
      expect(fixture.reportUnexpected).toHaveBeenCalledExactlyOnceWith(failure, {
        stage: 'canvas',
      }),
    );
    expect(fixture.disposeVisuals).toHaveBeenCalledOnce();
  },
);

test('preserves startup error identity when partial-start teardown also fails', async () => {
  const startupFailure = new Error('React render failed');
  const cleanupFailure = new Error('observer teardown failed');
  fixture.render.mockImplementationOnce(() => {
    throw startupFailure;
  });
  fixture.stopTelemetry.mockImplementationOnce(() => {
    throw cleanupFailure;
  });
  const { startWebApp } = await import('@/app/start-web-app');
  let caught: unknown;

  try {
    startWebApp({ ...inactiveTelemetry, reportUnexpected: fixture.reportUnexpected });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(startupFailure);
  expect(fixture.audioDispose).toHaveBeenCalledOnce();
  expect(fixture.presentationDispose).toHaveBeenCalledOnce();
  expect(fixture.unmount).toHaveBeenCalledOnce();
  expect(fixture.disposeVisuals).toHaveBeenCalledOnce();
  expect(fixture.sessionListeners.size).toBe(0);
  expect(fixture.reportUnexpected).toHaveBeenCalledExactlyOnceWith(cleanupFailure);
});

test('shows the replacement shell even when execution cleanup fails', async () => {
  const context = await start();
  const failure = new Error('presentation teardown failed');
  fixture.presentationDispose.mockImplementationOnce(() => {
    throw failure;
  });

  replaceSession();

  expect(context.activity.aborted).toBe(true);
  expect(context.globalActor.getSnapshot().matches('replaced')).toBe(true);
  expect(fixture.audioDispose).toHaveBeenCalledOnce();
  expect(fixture.unmount).not.toHaveBeenCalled();
  expect(fixture.disposeVisuals).not.toHaveBeenCalled();
  expect(fixture.reportUnexpected).toHaveBeenCalledExactlyOnceWith(failure);
});
