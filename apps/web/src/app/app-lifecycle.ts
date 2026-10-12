import type { BootstrapProgress } from '@/bootstrap/bootstrap-progress';
import type { StaticCapabilityResult } from '@/bootstrap/static-capabilities';

export type AppNetworkStatus = 'idle' | 'online' | 'offline';
export interface AppLifecycleDependencies {
  readonly capabilities: StaticCapabilityResult;
  readonly activateAudio: () => Promise<void>;
  readonly onUnexpected?: (error: unknown) => void;
  readonly loadResources: (
    onProgress: (progress: BootstrapProgress) => void,
    signal: AbortSignal,
  ) => Promise<void>;
}
export interface AppLifecycleSnapshot {
  readonly phase:
    | 'unsupported'
    | 'awaitingStart'
    | 'activatingAudio'
    | 'activationFailure'
    | 'loadingResources'
    | 'resourceFailure'
    | 'ready'
    | 'runtimeFailure'
    | 'replaced';
  readonly capabilities: StaticCapabilityResult;
  readonly networkStatus: AppNetworkStatus;
  readonly bootstrapProgress: BootstrapProgress;
}
export type AppLifecycle = ReturnType<typeof createAppLifecycle>;

/** App-owned bootstrap work outlives route mounts and stops before its resources are disposed. */
export function createAppLifecycle(dependencies: AppLifecycleDependencies) {
  let snapshot: AppLifecycleSnapshot = {
    phase: dependencies.capabilities.ok ? 'awaitingStart' : 'unsupported',
    capabilities: dependencies.capabilities,
    networkStatus: 'idle',
    bootstrapProgress: { phase: 'modules', progress: 0 },
  };
  const listeners = new Set<() => void>();
  let operation: AbortController | null = null;
  let disposed = false;
  const isCurrentOperation = (controller: AbortController) =>
    !disposed && operation === controller && !controller.signal.aborted;
  function publish(change: Partial<AppLifecycleSnapshot>) {
    if (disposed) return;
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }
  function cancelOperation() {
    operation?.abort();
    operation = null;
  }
  async function loadResources(controller: AbortController) {
    if (!isCurrentOperation(controller)) return;
    publish({ phase: 'loadingResources' });
    if (!isCurrentOperation(controller)) return;
    try {
      await dependencies.loadResources((bootstrapProgress) => {
        if (isCurrentOperation(controller)) publish({ bootstrapProgress });
      }, controller.signal);
      if (!isCurrentOperation(controller)) return;
      operation = null;
      publish({ phase: 'ready', bootstrapProgress: { phase: 'gpu', progress: 1 } });
    } catch {
      if (!isCurrentOperation(controller)) return;
      operation = null;
      publish({ phase: 'resourceFailure' });
    }
  }
  async function activateAudioAndLoadResources(controller: AbortController) {
    try {
      // Execute in the start gesture, before any await or React effect.
      await dependencies.activateAudio();
    } catch (cause) {
      if (!isCurrentOperation(controller)) return;
      operation = null;
      publish({ phase: 'activationFailure' });
      dependencies.onUnexpected?.(cause);
      return;
    }
    await loadResources(controller);
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    startBootstrap() {
      if (
        disposed ||
        (snapshot.phase !== 'awaitingStart' && snapshot.phase !== 'activationFailure')
      )
        return;
      const controller = new AbortController();
      operation = controller;
      publish({ phase: 'activatingAudio' });
      if (isCurrentOperation(controller)) void activateAudioAndLoadResources(controller);
    },
    retryResources() {
      if (disposed || snapshot.phase !== 'resourceFailure') return;
      const controller = new AbortController();
      operation = controller;
      void loadResources(controller);
    },
    setNetworkStatus(networkStatus: AppNetworkStatus) {
      if (snapshot.phase !== 'replaced' && snapshot.networkStatus !== networkStatus)
        publish({ networkStatus });
    },
    reportRuntimeFailure() {
      if (snapshot.phase !== 'loadingResources' && snapshot.phase !== 'ready') return;
      cancelOperation();
      publish({ phase: 'runtimeFailure' });
    },
    replaceSession() {
      if (snapshot.phase === 'replaced') return;
      cancelOperation();
      publish({ phase: 'replaced' });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelOperation();
      listeners.clear();
    },
  };
}
