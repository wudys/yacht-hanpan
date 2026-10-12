import { expect, test, vi } from 'vitest';

import { type AppLifecycleDependencies, createAppLifecycle } from '@/app/app-lifecycle';
import { CAPABILITY_FAILURE_CODE } from '@/bootstrap/static-capabilities';

const supportedCapabilities = { ok: true } as const;

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

test('keeps bootstrap inert when a required capability is unavailable', () => {
  let calls = 0;
  const lifecycle = createAppLifecycle({
    capabilities: { ok: false, code: CAPABILITY_FAILURE_CODE.WEBGL_UNAVAILABLE },
    activateAudio: () => {
      calls += 1;
      return Promise.resolve();
    },
    loadResources: () => {
      calls += 1;
      return Promise.resolve();
    },
  });

  lifecycle.startBootstrap();

  expect(lifecycle.getSnapshot().phase === 'unsupported').toBe(true);
  expect(lifecycle.getSnapshot().capabilities).toEqual({
    ok: false,
    code: CAPABILITY_FAILURE_CODE.WEBGL_UNAVAILABLE,
  });
  expect(calls).toBe(0);
  lifecycle.dispose();
});

test('retries resources without repeating audio activation', async () => {
  let activations = 0;
  let loads = 0;
  const lifecycle = createAppLifecycle({
    capabilities: supportedCapabilities,
    activateAudio: async () => {
      activations += 1;
    },
    loadResources: async () => {
      if (++loads === 1) throw new Error('offline');
    },
  });
  lifecycle.startBootstrap();
  await vi.waitFor(() => expect(lifecycle.getSnapshot().phase).toBe('resourceFailure'));
  lifecycle.retryResources();
  await vi.waitFor(() => expect(lifecycle.getSnapshot().phase).toBe('ready'));
  expect(activations).toBe(1);
  expect(loads).toBe(2);
  lifecycle.dispose();
});

test('starts without bootstrap side effects and initializes persistent global state', () => {
  let calls = 0;
  const lifecycle = createAppLifecycle({
    capabilities: supportedCapabilities,
    activateAudio: () => {
      calls += 1;
      return Promise.resolve();
    },
    loadResources: () => {
      calls += 1;
      return Promise.resolve();
    },
  });

  expect(lifecycle.getSnapshot().phase === 'awaitingStart').toBe(true);
  expect(lifecycle.getSnapshot().networkStatus).toBe('idle');
  expect(calls).toBe(0);
  lifecycle.dispose();
});

test('activates audio once before loading resources', async () => {
  const activation = deferred();
  const loading = deferred();
  let activations = 0;
  let loads = 0;
  const runtime: AppLifecycleDependencies = {
    capabilities: supportedCapabilities,
    activateAudio: () => {
      activations += 1;
      return activation.promise;
    },
    loadResources: () => {
      loads += 1;
      return loading.promise;
    },
  };
  const lifecycle = createAppLifecycle(runtime);

  lifecycle.startBootstrap();
  lifecycle.startBootstrap();

  expect(lifecycle.getSnapshot().phase === 'activatingAudio').toBe(true);
  expect(activations).toBe(1);
  expect(loads).toBe(0);

  activation.resolve();
  await vi.waitFor(() => expect(lifecycle.getSnapshot().phase).toBe('loadingResources'));
  expect(loads).toBe(1);

  loading.resolve();
  await vi.waitFor(() => expect(lifecycle.getSnapshot().phase).toBe('ready'));
  expect(lifecycle.getSnapshot().bootstrapProgress.progress).toBe(1);
  lifecycle.dispose();
});

test('updates network independently of the active route', () => {
  const lifecycle = createAppLifecycle({
    capabilities: supportedCapabilities,
    activateAudio: () => Promise.resolve(),
    loadResources: () => Promise.resolve(),
  });

  lifecycle.setNetworkStatus('offline');

  expect(lifecycle.getSnapshot().networkStatus).toBe('offline');
  lifecycle.dispose();
});

test('accepts a renderer runtime failure only after readiness and keeps it terminal', async () => {
  const lifecycle = createAppLifecycle({
    capabilities: supportedCapabilities,
    activateAudio: () => Promise.resolve(),
    loadResources: () => Promise.resolve(),
  });

  lifecycle.reportRuntimeFailure();
  expect(lifecycle.getSnapshot().phase === 'awaitingStart').toBe(true);

  lifecycle.startBootstrap();
  await vi.waitFor(() => expect(lifecycle.getSnapshot().phase).toBe('ready'));
  lifecycle.reportRuntimeFailure();
  lifecycle.setNetworkStatus('online');
  lifecycle.retryResources();

  expect(lifecycle.getSnapshot().phase === 'runtimeFailure').toBe(true);
  lifecycle.dispose();
});

test('keeps a renderer failure terminal while other bootstrap work is still pending', async () => {
  const loading = deferred();
  let loadSignal: AbortSignal | undefined;
  const lifecycle = createAppLifecycle({
    capabilities: supportedCapabilities,
    activateAudio: () => Promise.resolve(),
    loadResources: (_onProgress, signal) => {
      loadSignal = signal;
      return loading.promise;
    },
  });
  lifecycle.startBootstrap();
  await vi.waitFor(() => expect(lifecycle.getSnapshot().phase).toBe('loadingResources'));

  lifecycle.reportRuntimeFailure();
  expect(loadSignal?.aborted).toBe(true);
  loading.resolve();
  await Promise.resolve();

  expect(lifecycle.getSnapshot().phase === 'runtimeFailure').toBe(true);
  expect(lifecycle.getSnapshot().bootstrapProgress.progress).toBe(0);
  lifecycle.dispose();
});

test('keeps bootstrap failures inside the global lifecycle', async () => {
  const unsupported = createAppLifecycle({
    capabilities: { ok: false, code: CAPABILITY_FAILURE_CODE.WEB_AUDIO_UNAVAILABLE },
    activateAudio: () => Promise.resolve(),
    loadResources: () => Promise.resolve(),
  });

  expect(unsupported.getSnapshot().phase === 'unsupported').toBe(true);
  unsupported.dispose();

  const failed = createAppLifecycle({
    capabilities: supportedCapabilities,
    activateAudio: () => Promise.resolve(),
    loadResources: () => Promise.reject(new Error('asset failed')),
  });

  failed.startBootstrap();
  await vi.waitFor(() => expect(failed.getSnapshot().phase).toBe('resourceFailure'));
  expect(failed.getSnapshot().bootstrapProgress.progress).toBe(0);
  failed.dispose();
});

test('does not load resources when audio activation fails', async () => {
  let loads = 0;
  const cause = new TypeError('activation rejected');
  const onUnexpected = vi.fn();
  const lifecycle = createAppLifecycle({
    capabilities: supportedCapabilities,
    activateAudio: () => Promise.reject(cause),
    onUnexpected,
    loadResources: () => {
      loads += 1;
      return Promise.resolve();
    },
  });

  lifecycle.startBootstrap();

  await vi.waitFor(() => expect(lifecycle.getSnapshot().phase).toBe('activationFailure'));

  expect(loads).toBe(0);
  expect(onUnexpected).toHaveBeenCalledExactlyOnceWith(cause);
  lifecycle.dispose();
});

test.each(['stop', 'replace'] as const)('ignores an activation rejection after %s', async (end) => {
  let rejectActivation!: (error: Error) => void;
  const onUnexpected = vi.fn();
  const loadResources = vi.fn(() => Promise.resolve());
  const lifecycle = createAppLifecycle({
    capabilities: supportedCapabilities,
    onUnexpected,
    activateAudio: () =>
      new Promise<void>((_resolve, reject) => {
        rejectActivation = reject;
      }),
    loadResources,
  });
  lifecycle.startBootstrap();
  if (end === 'stop') lifecycle.dispose();
  else lifecycle.replaceSession();
  rejectActivation(new TypeError('late activation'));
  await Promise.resolve();
  expect(onUnexpected).not.toHaveBeenCalled();
  expect(loadResources).not.toHaveBeenCalled();
  lifecycle.dispose();
});

test.each(['runtime failure', 'session replacement', 'dispose'] as const)(
  'ignores late resource progress and completion after %s',
  async (ending) => {
    const loading = deferred();
    let signal: AbortSignal | undefined;
    let report!: Parameters<AppLifecycleDependencies['loadResources']>[0];
    const lifecycle = createAppLifecycle({
      capabilities: supportedCapabilities,
      activateAudio: () => Promise.resolve(),
      loadResources: (onProgress, loadSignal) => {
        signal = loadSignal;
        report = onProgress;
        return loading.promise;
      },
    });
    try {
      lifecycle.startBootstrap();
      await vi.waitFor(() => expect(lifecycle.getSnapshot().phase).toBe('loadingResources'));
      if (ending === 'runtime failure') lifecycle.reportRuntimeFailure();
      else if (ending === 'session replacement') lifecycle.replaceSession();
      else lifecycle.dispose();
      const ended = lifecycle.getSnapshot();
      expect(signal?.aborted).toBe(true);
      report({ phase: 'gpu', progress: 1 });
      loading.resolve();
      await loading.promise;
      await Promise.resolve();
      expect(lifecycle.getSnapshot()).toBe(ended);
    } finally {
      lifecycle.dispose();
    }
  },
);
