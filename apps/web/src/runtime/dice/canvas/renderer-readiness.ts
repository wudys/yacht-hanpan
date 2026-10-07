type RendererReadinessSnapshot = Readonly<{
  status: 'idle' | 'warming' | 'ready' | 'failed' | 'runtimeFailed' | 'disposed';
  attempt: number;
}>;

interface PendingWarmup {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  work: Promise<void> | null;
}

export function createRendererReadiness(onRuntimeFailure?: (error: unknown) => void) {
  let snapshot: RendererReadinessSnapshot = { status: 'idle', attempt: 0 };
  let pending: PendingWarmup | null = null;
  const listeners = new Set<() => void>();

  function publish(
    status: RendererReadinessSnapshot['status'],
    attempt: number = snapshot.attempt,
  ) {
    snapshot = { status, attempt };
    for (const listener of listeners) listener();
  }

  function fail(attempt: number, error: unknown) {
    if (attempt !== snapshot.attempt) return;
    if (snapshot.status === 'ready') {
      publish('runtimeFailed');
      onRuntimeFailure?.(error);
      return;
    }
    if (snapshot.status !== 'warming' || !pending) return;
    const active = pending;
    pending = null;
    publish('failed');
    active.reject(error);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    prepare(signal?: AbortSignal): Promise<void> {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (snapshot.status === 'disposed') return Promise.reject(new Error('Renderer is disposed'));
      if (snapshot.status === 'runtimeFailed')
        return Promise.reject(new Error('Renderer has failed'));
      if (snapshot.status === 'ready') return Promise.resolve();
      if (pending) return pending.promise;
      let onReady!: () => void;
      let onFailure!: (error: unknown) => void;
      const promise = new Promise<void>((resolve, reject) => {
        onReady = resolve;
        onFailure = reject;
      });
      pending = { promise, resolve: onReady, reject: onFailure, work: null };
      const attempt = snapshot.attempt + 1;
      if (signal) {
        const onAbort = () => fail(attempt, signal.reason);
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        void promise.then(cleanup, cleanup);
      }
      publish('warming', attempt);
      return promise;
    },
    run(attempt: number, warmup: () => Promise<void>): Promise<void> {
      if (attempt !== snapshot.attempt || snapshot.status !== 'warming' || !pending)
        return Promise.resolve();
      const active = pending;
      active.work ??= (async () => {
        try {
          await warmup();
          if (pending !== active) return;
          pending = null;
          publish('ready');
          active.resolve();
        } catch (error) {
          fail(attempt, error);
        }
      })();
      return active.work;
    },
    fail,
    dispose() {
      if (snapshot.status === 'disposed') return;
      const active = pending;
      pending = null;
      publish('disposed');
      active?.reject(new Error('Renderer is disposed'));
      listeners.clear();
    },
  };
}

export type RendererReadiness = ReturnType<typeof createRendererReadiness>;
