// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { parseSimulationInput, type SimulationResult } from '@repo/dice-simulation/contract';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, expect, type Mock, test, vi } from 'vitest';

import { createProductVisualResources } from '@/bootstrap/product-visual-resources';
import { runPhysicsDiagnostic } from '@/dev/physics-diagnostic-simulation';
import { PhysicsDiagnostic } from '@/dev/PhysicsDiagnostic';
import type { RendererReadiness } from '@/runtime/dice/canvas/renderer-readiness';
import type { DicePresentationView } from '@/runtime/dice/dice-presentation';
import type { ProceduralDiceResources } from '@/runtime/dice/resources';

vi.mock('@/dev/physics-diagnostic-simulation', () => ({ runPhysicsDiagnostic: vi.fn() }));
vi.mock('@/bootstrap/product-visual-resources', () => ({ createProductVisualResources: vi.fn() }));

interface CanvasPorts {
  renderer: RendererReadiness;
  presentation: DicePresentationView;
}
const canvases = new Map<RendererReadiness, CanvasPorts>();
vi.mock('@/runtime/dice/canvas/DiceCanvasHost', () => ({
  default: function CanvasHostDouble(ports: CanvasPorts) {
    canvases.set(ports.renderer, ports);
    const renderer = useSyncExternalStore(ports.renderer.subscribe, ports.renderer.getSnapshot);
    const presentation = useSyncExternalStore(
      ports.presentation.subscribe,
      ports.presentation.getSnapshot,
    );
    return (
      <div data-testid='canvas-port' data-state={renderer.status} data-phase={presentation.phase} />
    );
  },
}));

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const input = parseSimulationInput({
  rollId: 'quality-visual-fixture',
  seed: 'fixture-lifecycle',
  pourStyle: 'classic',
  rolledSlots: [0, 1],
});
const result: SimulationResult = {
  input,
  replayDigest: 'fixture-lifecycle-digest',
  authoritativeValuesBySlot: [
    { slot: 0, value: 2 },
    { slot: 1, value: 5 },
  ],
  timeline: {
    ...input,
    durationMs: 100,
    dice: [],
    rollArea: { width: 4, depth: 4, aspectRatio: 1 },
    cup: {
      style: 'classic',
      shakeAmplitude: 0,
      shakeFrequency: 0,
      pourAtMs: 0,
      releaseAtMs: 0,
      exitAtMs: 0,
      innerWidth: 1,
      innerDepth: 1,
      innerHeight: 1,
      frames: [],
    },
  },
};
const resources = { dispose: vi.fn() } as unknown as ProceduralDiceResources;
interface VisualOwnerDouble {
  preload: Mock<() => Promise<ProceduralDiceResources>>;
  dispose: Mock<() => Promise<void>>;
}
const owners: VisualOwnerDouble[] = [];
function makeOwner(
  load: () => Promise<ProceduralDiceResources> = async () => resources,
): VisualOwnerDouble {
  const owner = { preload: vi.fn(load), dispose: vi.fn(async () => {}) };
  owners.push(owner);
  return owner;
}

beforeEach(() => {
  canvases.clear();
  owners.length = 0;
  vi.mocked(createProductVisualResources)
    .mockReset()
    .mockImplementation(() => makeOwner());
  vi.mocked(runPhysicsDiagnostic).mockReset().mockResolvedValue(result);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function run(seed: string = input.seed) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Seed' }), { target: { value: seed } });
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Dice count' }), {
    target: { value: '2' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Run' }));
}
async function mount() {
  const loading = deferred<ProceduralDiceResources>();
  vi.mocked(createProductVisualResources).mockImplementationOnce(() =>
    makeOwner(() => loading.promise),
  );
  const view = render(<PhysicsDiagnostic />);
  run();
  await act(async () => loading.resolve(resources));
  const ports = [...canvases.values()].at(-1)!;
  expect(ports.renderer.getSnapshot().status).toBe('warming');
  return { view, ports };
}
async function warmup(ports: CanvasPorts) {
  await act(async () => ports.renderer.run(ports.renderer.getSnapshot().attempt, async () => {}));
  expect(ports.renderer.getSnapshot().status).toBe('ready');
}

test('does not create resources or simulate until Run is requested', () => {
  render(<PhysicsDiagnostic />);
  expect(createProductVisualResources).not.toHaveBeenCalled();
  expect(runPhysicsDiagnostic).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Replay' }).hasAttribute('disabled')).toBe(true);
});

test('retains raw final pose and the submitted input while its draft is edited', async () => {
  const { ports } = await mount();
  await warmup(ports);
  act(() => ports.presentation.completePlayback(input.rollId));
  expect(screen.getByRole('button', { name: 'Replay' }).getAttribute('data-physics-complete')).toBe(
    'true',
  );
  expect(screen.getByTestId('canvas-port').getAttribute('data-phase')).toBe('rolling');
  fireEvent.change(screen.getByRole('textbox', { name: 'Seed' }), {
    target: { value: 'draft-only' },
  });
  expect(screen.getByTestId('physics-current-seed').textContent).toBe(input.seed);
  expect(runPhysicsDiagnostic).toHaveBeenCalledOnce();
  expect(owners[0].dispose).not.toHaveBeenCalled();
});

test('a new Run clears the old result and completion and disposes its renderer and resources', async () => {
  const { ports } = await mount();
  await warmup(ports);
  act(() => ports.presentation.completePlayback(input.rollId));
  const pending = deferred<SimulationResult>();
  vi.mocked(runPhysicsDiagnostic).mockReturnValueOnce(pending.promise);
  run('next-run');
  expect(ports.renderer.getSnapshot().status).toBe('disposed');
  expect(owners[0].dispose).toHaveBeenCalledOnce();
  expect(screen.getByTestId('physics-current-seed').textContent).toBe('next-run');
  const replay = screen.getByRole('button', { name: 'Replay' });
  expect(replay.getAttribute('data-physics-complete')).toBe('false');
  expect(screen.queryByTestId('physics-result-digest')).toBeNull();
  await act(async () => pending.resolve({ ...result, input: { ...input, seed: 'next-run' } }));
  const next = [...canvases.values()].at(-1)!;
  expect(next.renderer).not.toBe(ports.renderer);
  expect(owners[1].dispose).not.toHaveBeenCalled();
  await warmup(next);
  act(() => ports.presentation.completePlayback(input.rollId));
  expect(replay.getAttribute('data-physics-complete')).toBe('false');
  act(() => next.presentation.completePlayback(input.rollId));
  expect(replay.getAttribute('data-physics-complete')).toBe('true');
});

test.each(['preload', 'simulation'] as const)(
  'reports %s failure and permits a fresh Run',
  async (boundary) => {
    const failure = new Error(`${boundary} failed`);
    if (boundary === 'preload') {
      vi.mocked(createProductVisualResources).mockImplementationOnce(() =>
        makeOwner(async () => {
          throw failure;
        }),
      );
    } else {
      vi.mocked(runPhysicsDiagnostic).mockRejectedValueOnce(failure);
    }
    render(<PhysicsDiagnostic />);
    run();
    expect((await screen.findByRole('alert')).textContent).toBe(failure.message);
    expect(screen.getByRole('button', { name: 'Replay' }).hasAttribute('disabled')).toBe(true);
    run('retry-run');
    await screen.findByTestId('canvas-port');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(owners[0].dispose).toHaveBeenCalledOnce();
    expect(owners[1].dispose).not.toHaveBeenCalled();
  },
);

test('reports an active warm-up rejection without completing the raw replay', async () => {
  const { ports } = await mount();
  const gate = deferred<void>();
  const warming = ports.renderer.run(ports.renderer.getSnapshot().attempt, () => gate.promise);
  await act(async () => {
    gate.reject(new Error('shader warm-up failed'));
    await warming;
  });
  expect(screen.getByRole('alert').textContent).toBe('shader warm-up failed');
  const replay = screen.getByRole('button', { name: 'Replay' });
  expect(replay.hasAttribute('disabled')).toBe(false);
  act(() => ports.presentation.completePlayback(input.rollId));
  expect(replay.getAttribute('data-physics-complete')).toBe('false');
});

test.each([false, true])(
  'runtime failure invalidates completion (previously completed=%s)',
  async (completed) => {
    const { ports } = await mount();
    await warmup(ports);
    if (completed) act(() => ports.presentation.completePlayback(input.rollId));
    const replay = screen.getByRole('button', { name: 'Replay' });
    expect(replay.getAttribute('data-physics-complete')).toBe(String(completed));
    act(() => ports.renderer.fail(ports.renderer.getSnapshot().attempt, new Error('context lost')));
    expect(screen.getByRole('alert').textContent).toBe('context lost');
    expect(replay.getAttribute('data-physics-complete')).toBe('false');
    act(() => ports.presentation.completePlayback(input.rollId));
    expect(replay.getAttribute('data-physics-complete')).toBe('false');
  },
);

test('Replay clears an error and reuses the result and resources with a new renderer generation', async () => {
  const { ports } = await mount();
  await warmup(ports);
  act(() => ports.renderer.fail(ports.renderer.getSnapshot().attempt, new Error('context lost')));
  const replay = screen.getByRole('button', { name: 'Replay' });
  fireEvent.click(replay);
  const next = [...canvases.values()].at(-1)!;
  expect(screen.queryByRole('alert')).toBeNull();
  expect(ports.renderer.getSnapshot().status).toBe('disposed');
  expect(next.renderer).not.toBe(ports.renderer);
  expect(next.presentation.getSnapshot().resources).toBe(resources);
  expect(createProductVisualResources).toHaveBeenCalledOnce();
  expect(owners[0].preload).toHaveBeenCalledOnce();
  expect(owners[0].dispose).not.toHaveBeenCalled();
  expect(runPhysicsDiagnostic).toHaveBeenCalledOnce();
  expect(screen.getByTestId('physics-result-digest').textContent).toBe(result.replayDigest);
  act(() => ports.presentation.completePlayback(input.rollId));
  act(() => ports.renderer.fail(ports.renderer.getSnapshot().attempt, new Error('stale failure')));
  expect(replay.getAttribute('data-physics-complete')).toBe('false');
  expect(screen.queryByRole('alert')).toBeNull();
  await warmup(next);
  act(() => next.presentation.completePlayback(input.rollId));
  expect(replay.getAttribute('data-physics-complete')).toBe('true');
});

test.each(['resolve', 'reject'] as const)(
  'consumes disposed renderer preparation and late warm-up %s after unmount',
  async (outcome) => {
    const { view, ports } = await mount();
    const gate = deferred<void>();
    const warming = ports.renderer.run(ports.renderer.getSnapshot().attempt, () => gate.promise);
    view.unmount();
    expect(ports.renderer.getSnapshot().status).toBe('disposed');
    expect(owners[0].dispose).toHaveBeenCalledOnce();
    await act(async () => {
      if (outcome === 'resolve') gate.resolve();
      else gate.reject(new Error('late shader failure'));
      await warming;
    });
    expect(screen.queryByRole('button', { name: 'Replay' })).toBeNull();
  },
);

test.each(['resolve', 'reject'] as const)(
  'ignores disposed preparation and late warm-up %s after Replay',
  async (outcome) => {
    const { ports } = await mount();
    const gate = deferred<void>();
    const warming = ports.renderer.run(ports.renderer.getSnapshot().attempt, () => gate.promise);
    const replay = screen.getByRole('button', { name: 'Replay' });
    fireEvent.click(replay);
    const next = [...canvases.values()].at(-1)!;
    await warmup(next);
    await act(async () => {
      if (outcome === 'resolve') gate.resolve();
      else gate.reject(new Error('late shader failure'));
      await warming;
    });
    act(() => ports.presentation.completePlayback(input.rollId));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(replay.getAttribute('data-physics-complete')).toBe('false');
    act(() => next.presentation.completePlayback(input.rollId));
    expect(replay.getAttribute('data-physics-complete')).toBe('true');
  },
);

test.each(['resolve', 'reject'] as const)(
  'ignores disposed preparation and late warm-up %s after a fresh Run',
  async (outcome) => {
    const { ports } = await mount();
    const gate = deferred<void>();
    const warming = ports.renderer.run(ports.renderer.getSnapshot().attempt, () => gate.promise);
    run('new-run');
    await screen.findByTestId('canvas-port');
    const next = [...canvases.values()].at(-1)!;
    await warmup(next);
    await act(async () => {
      if (outcome === 'resolve') gate.resolve();
      else gate.reject(new Error('late shader failure'));
      await warming;
    });
    expect(ports.renderer.getSnapshot().status).toBe('disposed');
    expect(owners[0].dispose).toHaveBeenCalledOnce();
    expect(owners[1].dispose).not.toHaveBeenCalled();
    act(() => ports.presentation.completePlayback(input.rollId));
    const replay = screen.getByRole('button', { name: 'Replay' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(replay.getAttribute('data-physics-complete')).toBe('false');
    act(() => next.presentation.completePlayback(input.rollId));
    expect(replay.getAttribute('data-physics-complete')).toBe('true');
  },
);

test.each(['resolve', 'reject'] as const)(
  'ignores preload %s from a replaced Run',
  async (outcome) => {
    const loading = deferred<ProceduralDiceResources>();
    vi.mocked(createProductVisualResources).mockImplementationOnce(() =>
      makeOwner(() => loading.promise),
    );
    render(<PhysicsDiagnostic />);
    run('old-run');
    run('new-run');
    await screen.findByTestId('canvas-port');
    await act(async () => {
      if (outcome === 'resolve') loading.resolve(resources);
      else loading.reject(new Error('stale preload failure'));
    });
    expect(screen.getByTestId('physics-current-seed').textContent).toBe('new-run');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(runPhysicsDiagnostic).toHaveBeenCalledOnce();
    expect(owners[0].dispose).toHaveBeenCalledOnce();
    expect(owners[1].dispose).not.toHaveBeenCalled();
    expect(canvases.size).toBe(1);
  },
);

test.each(['resolve', 'reject'] as const)(
  'ignores calculation %s from a replaced Run',
  async (outcome) => {
    const calculation = deferred<SimulationResult>();
    vi.mocked(runPhysicsDiagnostic).mockReturnValueOnce(calculation.promise);
    render(<PhysicsDiagnostic />);
    run('old-run');
    await act(async () => {
      await Promise.resolve();
    });
    expect(runPhysicsDiagnostic).toHaveBeenCalledOnce();
    const oldSignal = vi.mocked(runPhysicsDiagnostic).mock.calls[0][1]!;
    run('new-run');
    expect(oldSignal.aborted).toBe(true);
    await screen.findByTestId('canvas-port');
    await act(async () => {
      if (outcome === 'resolve') calculation.resolve(result);
      else calculation.reject(new Error('stale calculation failure'));
    });
    expect(screen.getByTestId('physics-current-seed').textContent).toBe('new-run');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(owners[0].dispose).toHaveBeenCalledOnce();
    expect(owners[1].dispose).not.toHaveBeenCalled();
    expect(canvases.size).toBe(1);
  },
);

test('disposes resources and ignores preload completion after unmount', async () => {
  const loading = deferred<ProceduralDiceResources>();
  vi.mocked(createProductVisualResources).mockImplementationOnce(() =>
    makeOwner(() => loading.promise),
  );
  const view = render(<PhysicsDiagnostic />);
  run();
  view.unmount();
  await act(async () => loading.resolve(resources));
  expect(runPhysicsDiagnostic).not.toHaveBeenCalled();
  expect(owners[0].dispose).toHaveBeenCalledOnce();
  expect(canvases.size).toBe(0);
});

test('disposes resources and ignores calculation completion after unmount', async () => {
  const calculation = deferred<SimulationResult>();
  vi.mocked(runPhysicsDiagnostic).mockReturnValueOnce(calculation.promise);
  const view = render(<PhysicsDiagnostic />);
  run();
  await act(async () => {
    await Promise.resolve();
  });
  expect(runPhysicsDiagnostic).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => calculation.resolve(result));
  expect(vi.mocked(runPhysicsDiagnostic).mock.calls[0][1]?.aborted).toBe(true);
  expect(owners[0].dispose).toHaveBeenCalledOnce();
  expect(canvases.size).toBe(0);
});
