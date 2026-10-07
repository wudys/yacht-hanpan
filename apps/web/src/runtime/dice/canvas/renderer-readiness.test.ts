import { expect, test, vi } from 'vitest';

import { createRendererReadiness as createReadinessGate } from '@/runtime/dice/canvas/renderer-readiness';

test('cancels pending warm-up and ignores its late completion during a retry', async () => {
  const renderer = createReadinessGate();
  const activity = new AbortController();
  const ready = renderer.prepare(activity.signal).catch((error: unknown) => error);
  let complete!: () => void;
  const work = renderer.run(
    renderer.getSnapshot().attempt,
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  activity.abort();
  expect(renderer.getSnapshot().status).toBe('failed');
  expect(await ready).toBe(activity.signal.reason);
  const retry = renderer.prepare();
  complete();
  await work;
  expect(renderer.getSnapshot().status).toBe('warming');
  await renderer.run(renderer.getSnapshot().attempt, async () => undefined);
  await retry;
  expect(renderer.getSnapshot().status).toBe('ready');
});

test('keeps readiness pending until one shared renderer warm-up finishes', async () => {
  const renderer = createReadinessGate();
  let release!: () => void;
  const compile = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const ready = renderer.prepare();
  const duplicate = renderer.prepare();
  expect(duplicate).toBe(ready);
  expect(renderer.getSnapshot().status).toBe('warming');
  const { attempt } = renderer.getSnapshot();
  const first = renderer.run(attempt, compile);
  const second = renderer.run(attempt, compile);
  expect(compile).toHaveBeenCalledTimes(1);
  expect(renderer.getSnapshot().status).toBe('warming');
  release();
  await Promise.all([ready, first, second]);
  expect(renderer.getSnapshot().status).toBe('ready');
  await renderer.prepare();
  expect(compile).toHaveBeenCalledTimes(1);
});

test('retries a failed warm-up and ignores errors from an older attempt', async () => {
  const renderer = createReadinessGate();
  const failed = renderer.prepare();
  const oldAttempt = renderer.getSnapshot().attempt;
  const rejection = expect(failed).rejects.toThrow('shader failure');
  await renderer.run(oldAttempt, async () => {
    throw new Error('shader failure');
  });
  await rejection;
  const ready = renderer.prepare();
  renderer.fail(oldAttempt, new Error('stale callback'));
  expect(renderer.getSnapshot().status).toBe('warming');
  await renderer.run(renderer.getSnapshot().attempt, async () => undefined);
  await ready;
  expect(renderer.getSnapshot().status).toBe('ready');
});

test('publishes a same-attempt renderer failure after readiness', async () => {
  const renderer = createReadinessGate();
  const ready = renderer.prepare();
  const { attempt } = renderer.getSnapshot();
  await renderer.run(attempt, async () => undefined);
  await ready;
  const listener = vi.fn();
  renderer.subscribe(listener);

  renderer.fail(attempt, new Error('render boundary failure'));

  expect(renderer.getSnapshot()).toEqual({ status: 'runtimeFailed', attempt });
  expect(listener).toHaveBeenCalledOnce();
});

test('terminal disposal rejects pending readiness and prevents later completion', async () => {
  const renderer = createReadinessGate();
  const ready = renderer.prepare();
  const rejection = expect(ready).rejects.toThrow('disposed');
  const { attempt } = renderer.getSnapshot();
  renderer.dispose();
  await rejection;
  const compile = vi.fn(async () => undefined);
  await renderer.run(attempt, compile);
  expect(compile).not.toHaveBeenCalled();
  expect(renderer.getSnapshot().status).toBe('disposed');
  await expect(renderer.prepare()).rejects.toThrow('disposed');
});

test('reports the original runtime failure once without a React context and ignores stale callbacks', async () => {
  const report = vi.fn();
  const renderer = createReadinessGate(report);
  const ready = renderer.prepare();
  const { attempt } = renderer.getSnapshot();
  await renderer.run(attempt, async () => undefined);
  await ready;
  const error = new Error('original canvas stack');
  renderer.fail(attempt - 1, new Error('stale'));
  renderer.fail(attempt, error);
  renderer.fail(attempt, error);
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
  expect(renderer.getSnapshot().status).toBe('runtimeFailed');
});

test('rejects preparation after runtime failure, including subscriber reentry', async () => {
  const report = vi.fn();
  const renderer = createReadinessGate(report);
  const ready = renderer.prepare();
  const { attempt } = renderer.getSnapshot();
  await renderer.run(attempt, async () => undefined);
  await ready;
  let reentry: Promise<unknown> | undefined;
  renderer.subscribe(() => {
    if (renderer.getSnapshot().status === 'runtimeFailed') {
      reentry = renderer.prepare().catch((error: unknown) => error);
    }
  });
  const failure = new Error('context lost');

  renderer.fail(attempt, failure);

  expect(renderer.getSnapshot()).toEqual({ status: 'runtimeFailed', attempt });
  expect(await reentry).toBeInstanceOf(Error);
  await expect(renderer.prepare()).rejects.toThrow('failed');
  const warmup = vi.fn(async () => undefined);
  await renderer.run(attempt, warmup);
  expect(warmup).not.toHaveBeenCalled();
  renderer.fail(attempt, failure);
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  await expect(renderer.prepare(AbortSignal.abort('cancelled'))).rejects.toBe('cancelled');
});
