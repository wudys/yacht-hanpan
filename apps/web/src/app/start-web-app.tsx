import '@/app/styles.css';

import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { type ActorRefFrom, createActor } from 'xstate';

import { appLifecycleMachine } from '@/app/app-lifecycle-machine';
import { createAppRouter } from '@/app/app-router';
import { createProductExecution } from '@/app/product-execution';
import { prepareProductResources } from '@/bootstrap/prepare-product-resources';
import {
  createProductVisualPreparation,
  type ProductVisualPreparation,
} from '@/bootstrap/product-visual-preparation';
import { detectStaticGameplayCapabilities } from '@/bootstrap/static-capabilities';
import { parseWebConfig } from '@/bootstrap/web-config';
import { subscribeBrowserConnectivity } from '@/runtime/network/browser-connectivity';
import { createPreferencesStore } from '@/runtime/preferences/preferences-store';
import type { ErrorContext } from '@/runtime/telemetry/error-policy';
import { createReactErrorHandler } from '@/runtime/telemetry/react-errors';
import { observeSessionTelemetry } from '@/runtime/telemetry/session-telemetry-observer';
import type { Telemetry } from '@/runtime/telemetry/telemetry';
import { TelemetryContext } from '@/runtime/telemetry/TelemetryContext';

export function startWebApp(telemetry: Telemetry): () => void {
  const config = parseWebConfig(import.meta.env);
  const rootElement = document.querySelector<HTMLElement>('#root');
  if (rootElement === null) throw new Error('Web application root is missing');

  const preferences = createPreferencesStore({
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  });
  const execution = createProductExecution({
    serverUrl: config.gameServerUrl,
    releaseId: config.releaseId,
    preferences,
    telemetry,
  });
  const {
    activity,
    audio,
    access,
    client,
    profile,
    sessions,
    sessionCredentialStore,
    recovery,
    feedback,
    presentation,
  } = execution;
  let disposed = false;
  let visuals: ProductVisualPreparation | undefined;
  let appActor: ActorRefFrom<typeof appLifecycleMachine> | undefined;
  let reactRoot: Root | undefined;
  let stopTelemetry: (() => void) | undefined;
  let unsubscribeReplacement: (() => void) | undefined;
  let unsubscribeConnectivity: (() => void) | undefined;
  let unsubscribeRenderer: (() => void) | undefined;

  function cleanup(callback: () => void | Promise<void>, context?: ErrorContext) {
    const report = (error: unknown) => {
      try {
        if (context) telemetry.reportUnexpected(error, context);
        else telemetry.reportUnexpected(error);
      } catch {
        // A failed diagnostic must not interrupt the remaining cleanup.
      }
    };
    try {
      void Promise.resolve(callback()).catch(report);
    } catch (error) {
      report(error);
    }
  }

  function disposeApp() {
    if (disposed) return;
    disposed = true;
    cleanup(() => stopTelemetry?.());
    cleanup(() => unsubscribeReplacement?.());
    cleanup(() => unsubscribeConnectivity?.());
    cleanup(() => unsubscribeRenderer?.());
    cleanup(() => execution.stop());
    cleanup(() => {
      appActor?.stop();
    });
    cleanup(() => reactRoot?.unmount());
    cleanup(() => visuals?.dispose(), { stage: 'canvas' });
  }

  try {
    const { bgmEnabled } = preferences.getSnapshot();
    const capabilities = detectStaticGameplayCapabilities({
      fetch: typeof globalThis.fetch === 'function',
      webAssembly: typeof globalThis.WebAssembly === 'object',
      webGl: typeof globalThis.WebGL2RenderingContext === 'function',
      webAudio: audio.supported,
    });
    const productVisuals = createProductVisualPreparation({
      activity,
      presentation,
      onRuntimeFailure: (error) => telemetry.reportUnexpected(error, { stage: 'canvas' }),
    });
    visuals = productVisuals;
    const productRenderer = productVisuals.renderer;
    stopTelemetry = observeSessionTelemetry({
      telemetry,
      sessions,
      recovery,
      reentry: execution.reentry,
    });
    const globalActor = createActor(appLifecycleMachine, {
      input: {
        capabilities,
        onUnexpected: (error) => telemetry.reportUnexpected(error, { stage: 'audio' }),
        activateAudio: audio.activate,
        loadResources: async (onProgress, signal) => {
          const startedAt = performance.now();
          try {
            try {
              profile.initialize();
            } catch (error) {
              telemetry.reportUnexpected(error, { stage: 'storage' });
              throw error;
            }
            await prepareProductResources({
              signal,
              onProgress,
              onFailure: (stage, error) => {
                if (!signal.aborted && !activity.aborted)
                  telemetry.reportUnexpected(error, { stage });
              },
              bgmEnabled,
              prefetchScenes: audio.prefetchScenes,
              prepareProductAudio: audio.prepareCues,
              prepareVisuals: productVisuals.prepare,
              loadModules: () =>
                Promise.all([
                  import('@/features/lobby/LobbyScreen'),
                  import('@/features/game/GameScreen'),
                ]),
            });
            if (signal.aborted || activity.aborted) return;
            sessionCredentialStore.initialize();
            telemetry.trackEvent({
              name: 'bootstrap_result',
              outcome: 'success',
              duration_ms: Math.round(performance.now() - startedAt),
            });
          } catch (error) {
            if (signal.aborted || activity.aborted) return;
            telemetry.trackEvent({
              name: 'bootstrap_result',
              outcome: 'failure',
              duration_ms: Math.round(performance.now() - startedAt),
            });
            throw error;
          }
        },
      },
    });
    appActor = globalActor;
    unsubscribeReplacement = sessions.subscribe(() => {
      if (sessions.getSnapshot().sessionSnapshot?.connection === 'replaced') {
        if (activity.aborted) return;
        execution.stop();
        globalActor.send({ type: 'SESSION.REPLACED' });
      }
    });
    globalActor.start();
    unsubscribeConnectivity = subscribeBrowserConnectivity((online) => {
      globalActor.send({ type: 'NETWORK.CHANGED', status: online ? 'online' : 'offline' });
    });
    unsubscribeRenderer = productRenderer.subscribe(() => {
      if (productRenderer.getSnapshot().status === 'runtimeFailed') {
        globalActor.send({ type: 'RUNTIME.CAPABILITY_FAILED' });
      }
    });
    const router = createAppRouter({
      access,
      activity,
      audio,
      feedback,
      globalActor,
      profile,
      preferences,
      renderer: productRenderer,
      clock: client.clock,
      sessions,
      sessionCredentialStore,
      recovery,
      presentation,
    });

    reactRoot = createRoot(rootElement, {
      onUncaughtError: createReactErrorHandler(false),
      onCaughtError: createReactErrorHandler(true),
    });
    reactRoot.render(
      <StrictMode>
        <TelemetryContext.Provider value={telemetry}>
          <RouterProvider router={router} />
        </TelemetryContext.Provider>
      </StrictMode>,
    );

    return disposeApp;
  } catch (error) {
    disposeApp();
    throw error;
  }
}
