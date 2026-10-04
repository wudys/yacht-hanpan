import { expect, test, vi } from 'vitest';
import { createActor, waitFor } from 'xstate';

import { appLifecycleMachine, type AppLifecycleRuntime } from '@/app/app-lifecycle-machine';
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
  const actor = createActor(appLifecycleMachine, {
    input: {
      capabilities: { ok: false, code: CAPABILITY_FAILURE_CODE.WEBGL_UNAVAILABLE },
      activateAudio: () => {
        calls += 1;
        return Promise.resolve();
      },
      loadResources: () => {
        calls += 1;
        return Promise.resolve();
      },
    },
  }).start();

  actor.send({ type: 'BOOTSTRAP.START' });

  expect(actor.getSnapshot().matches('unsupported')).toBe(true);
  expect(actor.getSnapshot().context.runtime.capabilities).toEqual({
    ok: false,
    code: CAPABILITY_FAILURE_CODE.WEBGL_UNAVAILABLE,
  });
  expect(calls).toBe(0);
  actor.stop();
});

test('retries resources without repeating audio activation', async () => {
  let activations = 0;
  let loads = 0;
  const actor = createActor(appLifecycleMachine, {
    input: {
      capabilities: supportedCapabilities,
      activateAudio: async () => {
        activations += 1;
      },
      loadResources: async () => {
        if (++loads === 1) throw new Error('offline');
      },
    },
  }).start();
  actor.send({ type: 'BOOTSTRAP.START' });
  await waitFor(actor, (snapshot) => snapshot.matches('resourceFailure'));
  actor.send({ type: 'BOOTSTRAP.RETRY' });
  await waitFor(actor, (snapshot) => snapshot.matches('ready'), { timeout: 100 });
  expect(activations).toBe(1);
  expect(loads).toBe(2);
  actor.stop();
});

test('starts without bootstrap side effects and initializes persistent global state', () => {
  let calls = 0;
  const actor = createActor(appLifecycleMachine, {
    input: {
      capabilities: supportedCapabilities,
      activateAudio: () => {
        calls += 1;
        return Promise.resolve();
      },
      loadResources: () => {
        calls += 1;
        return Promise.resolve();
      },
    },
  });

  actor.start();

  expect(actor.getSnapshot().matches('interaction')).toBe(true);
  expect(actor.getSnapshot().context.networkStatus).toBe('idle');
  expect(calls).toBe(0);
  actor.stop();
});

test('activates audio once before loading resources', async () => {
  const activation = deferred();
  const loading = deferred();
  let activations = 0;
  let loads = 0;
  const runtime: AppLifecycleRuntime = {
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
  const actor = createActor(appLifecycleMachine, { input: runtime });
  actor.start();

  actor.send({ type: 'BOOTSTRAP.START' });
  actor.send({ type: 'BOOTSTRAP.START' });

  expect(actor.getSnapshot().matches('activatingAudio')).toBe(true);
  expect(activations).toBe(1);
  expect(loads).toBe(0);

  activation.resolve();
  await waitFor(actor, (snapshot) => snapshot.matches('loadingResources'));
  expect(loads).toBe(1);

  loading.resolve();
  await waitFor(actor, (snapshot) => snapshot.matches('ready'));
  expect(actor.getSnapshot().context.bootstrapProgress.progress).toBe(1);
  actor.stop();
});

test('updates network independently of the active route', () => {
  const actor = createActor(appLifecycleMachine, {
    input: {
      capabilities: supportedCapabilities,
      activateAudio: () => Promise.resolve(),
      loadResources: () => Promise.resolve(),
    },
  });
  actor.start();

  actor.send({ type: 'NETWORK.CHANGED', status: 'offline' });

  expect(actor.getSnapshot().context.networkStatus).toBe('offline');
  actor.stop();
});

test('accepts a renderer runtime failure only after readiness and keeps it terminal', async () => {
  const actor = createActor(appLifecycleMachine, {
    input: {
      capabilities: supportedCapabilities,
      activateAudio: () => Promise.resolve(),
      loadResources: () => Promise.resolve(),
    },
  }).start();

  actor.send({ type: 'RUNTIME.CAPABILITY_FAILED' });
  expect(actor.getSnapshot().matches('interaction')).toBe(true);

  actor.send({ type: 'BOOTSTRAP.START' });
  await waitFor(actor, (snapshot) => snapshot.matches('ready'));
  actor.send({ type: 'RUNTIME.CAPABILITY_FAILED' });
  actor.send({ type: 'NETWORK.CHANGED', status: 'connected' });
  actor.send({ type: 'BOOTSTRAP.RETRY' });

  expect(actor.getSnapshot().matches('runtimeFailure')).toBe(true);
  actor.stop();
});

test('keeps a renderer failure terminal while other bootstrap work is still pending', async () => {
  const loading = deferred();
  let loadSignal: AbortSignal | undefined;
  const actor = createActor(appLifecycleMachine, {
    input: {
      capabilities: supportedCapabilities,
      activateAudio: () => Promise.resolve(),
      loadResources: (_onProgress, signal) => {
        loadSignal = signal;
        return loading.promise;
      },
    },
  }).start();
  actor.send({ type: 'BOOTSTRAP.START' });
  await waitFor(actor, (snapshot) => snapshot.matches('loadingResources'));

  actor.send({ type: 'RUNTIME.CAPABILITY_FAILED' });
  expect(loadSignal?.aborted).toBe(true);
  loading.resolve();
  await Promise.resolve();

  expect(actor.getSnapshot().matches('runtimeFailure')).toBe(true);
  expect(actor.getSnapshot().context.bootstrapProgress.progress).toBe(0);
  actor.stop();
});

test('keeps bootstrap failures inside the global actor', async () => {
  const unsupported = createActor(appLifecycleMachine, {
    input: {
      capabilities: { ok: false, code: CAPABILITY_FAILURE_CODE.WEB_AUDIO_UNAVAILABLE },
      activateAudio: () => Promise.resolve(),
      loadResources: () => Promise.resolve(),
    },
  });
  unsupported.start();
  expect(unsupported.getSnapshot().matches('unsupported')).toBe(true);
  unsupported.stop();

  const failed = createActor(appLifecycleMachine, {
    input: {
      capabilities: supportedCapabilities,
      activateAudio: () => Promise.resolve(),
      loadResources: () => Promise.reject(new Error('asset failed')),
    },
  });
  failed.start();
  failed.send({ type: 'BOOTSTRAP.START' });
  await waitFor(failed, (snapshot) => snapshot.matches('resourceFailure'));
  expect(failed.getSnapshot().context.bootstrapProgress.progress).toBe(0);
  failed.stop();
});

test('does not load resources when audio activation fails', async () => {
  let loads = 0;
  const cause = new TypeError('activation rejected');
  const onUnexpected = vi.fn();
  const actor = createActor(appLifecycleMachine, {
    input: {
      capabilities: supportedCapabilities,
      activateAudio: () => Promise.reject(cause),
      onUnexpected,
      loadResources: () => {
        loads += 1;
        return Promise.resolve();
      },
    },
  });
  actor.start();
  actor.send({ type: 'BOOTSTRAP.START' });

  await waitFor(actor, (snapshot) => snapshot.matches('activationFailure'));

  expect(loads).toBe(0);
  expect(onUnexpected).toHaveBeenCalledExactlyOnceWith(cause);
  actor.stop();
});

test.each(['stop', 'replace'] as const)('ignores an activation rejection after %s', async (end) => {
  let rejectActivation!: (error: Error) => void;
  const onUnexpected = vi.fn();
  const loadResources = vi.fn(() => Promise.resolve());
  const actor = createActor(appLifecycleMachine, {
    input: {
      capabilities: supportedCapabilities,
      onUnexpected,
      activateAudio: () =>
        new Promise<void>((_resolve, reject) => {
          rejectActivation = reject;
        }),
      loadResources,
    },
  }).start();
  actor.send({ type: 'BOOTSTRAP.START' });
  if (end === 'stop') actor.stop();
  else actor.send({ type: 'SESSION.REPLACED' });
  rejectActivation(new TypeError('late activation'));
  await Promise.resolve();
  expect(onUnexpected).not.toHaveBeenCalled();
  expect(loadResources).not.toHaveBeenCalled();
  actor.stop();
});
