import { beforeEach, expect, test, vi } from 'vitest';

import type { ProductVisualResources } from '@/bootstrap/product-visual-resources';
import type { DicePresentationController } from '@/runtime/dice/dice-presentation-controller';
import type { ProceduralDiceResources } from '@/runtime/dice/resources';

const fixture = vi.hoisted(() => ({
  importResources: vi.fn(),
  createResources: vi.fn(),
  preload: vi.fn<ProductVisualResources['preload']>(),
  dispose: vi.fn<ProductVisualResources['dispose']>(),
  loadCanvas: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.createResources.mockImplementation(() => ({
    preload: fixture.preload,
    dispose: fixture.dispose,
  }));
  fixture.importResources.mockResolvedValue({
    createProductVisualResources: fixture.createResources,
  });
  fixture.preload.mockResolvedValue(createResources());
  fixture.dispose.mockResolvedValue(undefined);
  fixture.loadCanvas.mockResolvedValue({});
  vi.doMock('@/bootstrap/product-visual-resources', () => fixture.importResources());
  vi.doMock('@/runtime/dice/canvas/DiceCanvasHost', () => fixture.loadCanvas());
});

function createResources(): ProceduralDiceResources {
  // Preparation passes this identity through; the heavy resource owner tests its contents.
  return {
    get cup(): ProceduralDiceResources['cup'] {
      throw new Error('Preparation must not inspect cup resources');
    },
    get dieGeometry(): ProceduralDiceResources['dieGeometry'] {
      throw new Error('Preparation must not inspect die geometry');
    },
    dieMaterials: [],
    dispose: vi.fn(),
  };
}

function deferred<Value>() {
  let complete!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: complete };
}

async function createPreparation(
  presentation: Pick<DicePresentationController, 'prepare' | 'setResources'> = {
    prepare: vi.fn(async () => undefined),
    setResources: vi.fn(),
  },
  activity: AbortController = new AbortController(),
) {
  const { createProductVisualPreparation } = await import('@/bootstrap/product-visual-preparation');
  const failure = vi.fn();
  return {
    owner: createProductVisualPreparation({
      activity: activity.signal,
      presentation,
      onRuntimeFailure: failure,
    }),
    presentation,
    activity,
    failure,
  };
}

test('keeps heavy resources and Canvas code lazy until preparation starts', async () => {
  const { owner } = await createPreparation();
  expect(fixture.importResources).not.toHaveBeenCalled();
  expect(fixture.loadCanvas).not.toHaveBeenCalled();
  expect(owner.renderer.getSnapshot().status).toBe('idle');
  await owner.dispose();
  expect(fixture.createResources).not.toHaveBeenCalled();
});

test('does not install resources or warm the Canvas after the attempt is canceled', async () => {
  const canvas = deferred<object>();
  fixture.loadCanvas.mockReturnValue(canvas.promise);
  const { owner, presentation } = await createPreparation();
  const attempt = new AbortController();
  const renderer = vi.spyOn(owner.renderer, 'prepare');
  const report = vi.fn();
  const pending = owner.prepare(report, attempt.signal).catch((error: unknown) => error);
  await vi.waitFor(() => expect(fixture.loadCanvas).toHaveBeenCalledOnce());
  attempt.abort();
  canvas.resolve({});
  expect(await pending).toBe(attempt.signal.reason);
  expect(presentation.setResources).not.toHaveBeenCalled();
  expect(renderer).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  await owner.dispose();
});

test('prepares in parallel and waits for installed resources, Canvas code, and GPU readiness', async () => {
  const resources = createResources();
  const loaded = deferred<ProceduralDiceResources>();
  const resolver = deferred<void>();
  const canvas = deferred<object>();
  const gpu = deferred<void>();
  fixture.preload.mockReturnValue(loaded.promise);
  fixture.loadCanvas.mockReturnValue(canvas.promise);
  const presentation = { prepare: vi.fn(() => resolver.promise), setResources: vi.fn() };
  const { owner } = await createPreparation(presentation);
  const renderer = vi.spyOn(owner.renderer, 'prepare').mockReturnValue(gpu.promise);
  const report = vi.fn();
  const attempt = new AbortController();
  const pending = owner.prepare(report, attempt.signal);
  await vi.waitFor(() => expect(fixture.preload).toHaveBeenCalledWith(report, attempt.signal));
  expect(presentation.prepare).toHaveBeenCalledOnce();
  expect(fixture.loadCanvas).toHaveBeenCalledOnce();
  loaded.resolve(resources);
  await Promise.resolve();
  expect(presentation.setResources).not.toHaveBeenCalled();
  resolver.resolve();
  await Promise.resolve();
  expect(presentation.setResources).not.toHaveBeenCalled();
  expect(renderer).not.toHaveBeenCalled();
  canvas.resolve({});
  await vi.waitFor(() => expect(renderer).toHaveBeenCalledOnce());
  expect(presentation.setResources).toHaveBeenCalledOnce();
  expect(presentation.setResources.mock.calls[0]?.[0]).toBe(resources);
  expect(presentation.setResources.mock.invocationCallOrder[0]).toBeLessThan(
    renderer.mock.invocationCallOrder[0]!,
  );
  expect(report).not.toHaveBeenCalled();
  gpu.resolve();
  await pending;
  expect(report).toHaveBeenCalledExactlyOnceWith('gpu', 1);
  await owner.dispose();
});

test.each(['resources', 'resolver', 'canvas', 'gpu'] as const)(
  'propagates %s failure without reporting GPU completion',
  async (stage) => {
    const error = new Error(`${stage} unavailable`);
    const presentation = {
      prepare: vi.fn(async () => {
        if (stage === 'resolver') throw error;
      }),
      setResources: vi.fn(),
    };
    if (stage === 'resources') fixture.preload.mockRejectedValue(error);
    if (stage === 'canvas') fixture.loadCanvas.mockRejectedValue(error);
    const { owner } = await createPreparation(presentation);
    const renderer = vi.spyOn(owner.renderer, 'prepare').mockImplementation(async () => {
      if (stage === 'gpu') throw error;
    });
    const report = vi.fn();
    const rejected = owner
      .prepare(report, new AbortController().signal)
      .catch((cause: unknown) => cause);
    const cause = await rejected;
    if (stage === 'canvas') expect(cause).toMatchObject({ cause: error });
    else expect(cause).toBe(error);
    expect(report).not.toHaveBeenCalled();
    if (stage === 'resources' || stage === 'resolver') {
      expect(presentation.setResources).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(fixture.loadCanvas).toHaveBeenCalledOnce());
    }
    if (stage !== 'gpu') expect(renderer).not.toHaveBeenCalled();
    await owner.dispose();
  },
);

test('reuses acquired resources after failure and keeps preparation available after attempt cancellation', async () => {
  const resources = createResources();
  fixture.preload.mockRejectedValueOnce(new Error('decode failed')).mockResolvedValue(resources);
  const { owner, presentation } = await createPreparation();
  await expect(owner.prepare(vi.fn(), new AbortController().signal)).rejects.toThrow(
    'decode failed',
  );
  const attempt = new AbortController();
  const first = owner.prepare(vi.fn(), attempt.signal).catch((error: unknown) => error);
  await vi.waitFor(() => expect(owner.renderer.getSnapshot().status).toBe('warming'));
  attempt.abort();
  expect(await first).toBe(attempt.signal.reason);
  const report = vi.fn();
  const retry = owner.prepare(report, new AbortController().signal);
  await vi.waitFor(() => expect(owner.renderer.getSnapshot().status).toBe('warming'));
  await owner.renderer.run(owner.renderer.getSnapshot().attempt, async () => undefined);
  await retry;
  expect(fixture.createResources).toHaveBeenCalledOnce();
  expect(vi.mocked(presentation.setResources).mock.calls.at(-1)?.[0]).toBe(resources);
  expect(report).toHaveBeenCalledExactlyOnceWith('gpu', 1);
  await owner.dispose();
});

test('disposes resources imported after final disposal without starting preload', async () => {
  const imported = deferred<{ createProductVisualResources: typeof fixture.createResources }>();
  fixture.importResources.mockReturnValue(imported.promise);
  const { owner, presentation } = await createPreparation();
  const pending = owner
    .prepare(vi.fn(), new AbortController().signal)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(fixture.importResources).toHaveBeenCalledOnce());
  const disposal = owner.dispose();
  expect(owner.dispose()).toBe(disposal);
  imported.resolve({ createProductVisualResources: fixture.createResources });
  await disposal;
  expect(await pending).toEqual(new Error('Product visual preparation is disposed'));
  expect(fixture.createResources).toHaveBeenCalledOnce();
  expect(fixture.dispose).toHaveBeenCalledOnce();
  expect(fixture.preload).not.toHaveBeenCalled();
  expect(presentation.setResources).not.toHaveBeenCalled();
});

test('disposes acquired resources and ignores preload completed after final disposal', async () => {
  const preload = deferred<ProceduralDiceResources>();
  fixture.preload.mockReturnValue(preload.promise);
  const { owner, presentation } = await createPreparation();
  const report = vi.fn();
  const pending = owner
    .prepare(report, new AbortController().signal)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(fixture.preload).toHaveBeenCalledOnce());
  await owner.dispose();
  preload.resolve(createResources());
  expect(await pending).toEqual(new Error('Product visual preparation is disposed'));
  expect(presentation.setResources).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  await owner.dispose();
  expect(fixture.dispose).toHaveBeenCalledOnce();
});

test('activity stop cancels preparation without disposing shared resources or reviving the renderer', async () => {
  const preload = deferred<ProceduralDiceResources>();
  fixture.preload.mockReturnValue(preload.promise);
  const { owner, presentation, activity } = await createPreparation();
  const report = vi.fn();
  const pending = owner
    .prepare(report, new AbortController().signal)
    .catch((error: unknown) => error);
  await vi.waitFor(() => expect(fixture.preload).toHaveBeenCalledOnce());
  activity.abort();
  preload.resolve(createResources());
  expect(await pending).toBe(activity.signal.reason);
  expect(fixture.dispose).not.toHaveBeenCalled();
  expect(presentation.setResources).not.toHaveBeenCalled();
  expect(owner.renderer.getSnapshot().status).toBe('idle');
  expect(report).not.toHaveBeenCalled();
  await expect(owner.prepare(report, new AbortController().signal)).rejects.toBe(
    activity.signal.reason,
  );
  await owner.dispose();
  expect(fixture.dispose).toHaveBeenCalledOnce();
});

test('reports ready renderer failure through its child port', async () => {
  const { owner, failure } = await createPreparation();
  const pending = owner.prepare(vi.fn(), new AbortController().signal);
  await vi.waitFor(() => expect(owner.renderer.getSnapshot().status).toBe('warming'));
  const { attempt } = owner.renderer.getSnapshot();
  await owner.renderer.run(attempt, async () => undefined);
  await pending;
  const error = new Error('context lost');
  owner.renderer.fail(attempt, error);
  expect(failure).toHaveBeenCalledExactlyOnceWith(error);
  expect(owner.renderer.getSnapshot().status).toBe('runtimeFailed');
  await owner.dispose();
});
