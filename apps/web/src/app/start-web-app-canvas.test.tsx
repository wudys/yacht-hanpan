// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { useEffect } from 'react';
import type { WebGLRenderer } from 'three';
import { afterEach, expect, test, vi } from 'vitest';

import type { AppRouterContext } from '@/app/app-router';
import type { ProductExecution } from '@/app/product-execution';
import type { ProceduralDiceResources } from '@/runtime/dice/resources';
import { inactiveTelemetry } from '@/runtime/telemetry/telemetry';

const fixture = vi.hoisted(() => ({
  context: undefined as AppRouterContext | undefined,
  presentationListeners: new Set<() => void>(),
  activeConsumers: 0,
  consumersAtDispose: -1,
  rootsAtDispose: -1,
  rootCount: (): number => -1,
  disposeResources: vi.fn(),
}));

// Use the real React DOM root, visual owner, readiness, Canvas host and R3F reconciler.
// Inject only the GPU device and a scene leaf that observes borrowed-resource cleanup.
vi.mock('@react-three/fiber', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-three/fiber')>();
  fixture.rootCount = () => actual._roots.size;
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
vi.mock('@/runtime/dice/renderer', () => ({
  DiceRollWarmupScene: function BorrowedResourceConsumer() {
    useEffect(() => {
      fixture.activeConsumers += 1;
      return () => {
        fixture.activeConsumers -= 1;
      };
    }, []);
    return null;
  },
}));
vi.mock('@/bootstrap/product-visual-resources', () => ({
  createProductVisualResources: () => ({
    preload: async () => ({ dispose: vi.fn() }) as unknown as ProceduralDiceResources,
    dispose: async () => {
      fixture.consumersAtDispose = fixture.activeConsumers;
      fixture.rootsAtDispose = fixture.rootCount();
      fixture.disposeResources();
    },
  }),
}));
vi.mock('@/app/product-execution', () => ({
  createProductExecution: () => {
    const activity = new AbortController();
    let stopped = false;
    let snapshot: Readonly<{ phase: 'hidden'; resources: ProceduralDiceResources | null }> = {
      phase: 'hidden',
      resources: null,
    };
    return {
      activity: activity.signal,
      client: { clock: { now: () => null } },
      audio: {
        supported: true,
        activate: async () => undefined,
        prefetchScenes: async () => undefined,
        prepareCues: async () => undefined,
      },
      profile: { initialize: vi.fn() },
      store: { initialize: vi.fn() },
      sessions: { getSnapshot: () => ({}), subscribe: () => () => undefined },
      presentation: {
        prepare: async () => undefined,
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
          fixture.presentationListeners.add(listener);
          return () => fixture.presentationListeners.delete(listener);
        },
        setResources(resources: ProceduralDiceResources) {
          snapshot = { ...snapshot, resources };
          fixture.presentationListeners.forEach((listener) => listener());
        },
      },
      stop() {
        if (stopped) return;
        stopped = true;
        activity.abort();
      },
    } as unknown as ProductExecution;
  },
}));
vi.mock('@/app/app-router', () => ({
  createAppRouter: (context: AppRouterContext) => {
    fixture.context = context;
    return context;
  },
}));
vi.mock('@tanstack/react-router', async () => {
  const { PersistentDiceCanvas } = await import('@/runtime/dice/PersistentDiceCanvas');
  return {
    RouterProvider: ({ router }: Readonly<{ router: AppRouterContext }>) => (
      <PersistentDiceCanvas renderer={router.renderer} presentation={router.presentation} />
    ),
  };
});
vi.mock('@/bootstrap/web-config', () => ({
  parseWebConfig: () => ({ gameServerUrl: 'https://game.example.com', releaseId: 'release' }),
}));
vi.mock('@/bootstrap/static-capabilities', () => ({
  detectStaticGameplayCapabilities: () => ({ ok: true, missing: [] }),
}));
vi.mock('@/runtime/telemetry/observe-telemetry', () => ({
  observeTelemetry: () => () => undefined,
}));

let disposeApp: (() => void) | undefined;
afterEach(() => {
  act(() => disposeApp?.());
  disposeApp = undefined;
});

test('unmounts actual React and R3F Canvas consumers before disposing their shared resources', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  const { startWebApp } = await import('@/app/start-web-app');
  await act(async () => {
    disposeApp = startWebApp(inactiveTelemetry);
  });
  const { context } = fixture;
  if (!context) throw new Error('App router context missing');
  await act(async () => {
    context.globalActor.send({ type: 'BOOTSTRAP.START' });
  });
  await vi.waitFor(async () => {
    await act(async () => undefined);
    expect(context.renderer.getSnapshot().status).toBe('ready');
  });
  expect(fixture.activeConsumers).toBe(1);
  expect(fixture.rootCount()).toBe(1);

  act(() => disposeApp?.());
  await vi.waitFor(() => expect(fixture.disposeResources).toHaveBeenCalledOnce());

  expect(fixture.consumersAtDispose).toBe(0);
  expect(fixture.rootsAtDispose).toBe(0);
  expect(screen.queryByTestId('dice-canvas')).toBeNull();
  expect(fixture.presentationListeners.size).toBe(0);
  expect(context.activity.aborted).toBe(true);
  expect(context.renderer.getSnapshot().status).toBe('disposed');
});
