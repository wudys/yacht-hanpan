import { SimulationInputError, type SimulationResult } from '@repo/dice-simulation/contract';
import {
  DETERMINISTIC_RAPIER_WASM_FILE,
  initializeDeterministicRapierForBrowser,
} from '@repo/dice-simulation/rapier/browser';
import { simulateRoll } from '@repo/dice-simulation/simulate';
import { beforeEach, expect, test, vi } from 'vitest';

import { runPhysicsDiagnostic } from '@/dev/physics-diagnostic-simulation';

vi.mock('@repo/dice-simulation/rapier/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/dice-simulation/rapier/browser')>()),
  initializeDeterministicRapierForBrowser: vi.fn(),
}));
vi.mock('@repo/dice-simulation/simulate', () => ({ simulateRoll: vi.fn() }));

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

const input = { seed: 'physics-diagnostic', pourStyle: 'classic', count: 2 };
const result = { replayDigest: 'diagnostic-result' } as SimulationResult;

beforeEach(() => {
  vi.mocked(initializeDeterministicRapierForBrowser).mockReset().mockResolvedValue('ready');
  vi.mocked(simulateRoll).mockReset().mockResolvedValue(result);
});

test.each([0, 6, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects count=%s before allocating slots or initializing WASM',
  async (count) => {
    await expect(runPhysicsDiagnostic({ ...input, count })).rejects.toThrow(
      'Count must be an integer from 1 to 5',
    );
    expect(initializeDeterministicRapierForBrowser).not.toHaveBeenCalled();
    expect(simulateRoll).not.toHaveBeenCalled();
  },
);

test.each([
  { count: 1, slots: [0] },
  { count: 5, slots: [0, 1, 2, 3, 4] },
])('preserves the reviewed rollId and ordered slots for count=$count', async ({ count, slots }) => {
  await expect(runPhysicsDiagnostic({ ...input, count })).resolves.toBe(result);
  expect(simulateRoll).toHaveBeenCalledWith({
    rollId: 'quality-visual-fixture',
    seed: input.seed,
    pourStyle: input.pourStyle,
    rolledSlots: slots,
  });
});

test.each([{ seed: ' padded ' }, { pourStyle: 'unknown' }])(
  'delegates identifier and style rejection to the shared parser: %j',
  async (invalid) => {
    await expect(runPhysicsDiagnostic({ ...input, ...invalid })).rejects.toBeInstanceOf(
      SimulationInputError,
    );
    expect(initializeDeterministicRapierForBrowser).not.toHaveBeenCalled();
    expect(simulateRoll).not.toHaveBeenCalled();
  },
);

test('waits for the shared browser WASM before simulating', async () => {
  const readiness = deferred<string>();
  vi.mocked(initializeDeterministicRapierForBrowser).mockReturnValue(readiness.promise);
  const activity = new AbortController();
  const running = runPhysicsDiagnostic(input, activity.signal);
  expect(initializeDeterministicRapierForBrowser).toHaveBeenCalledWith(
    `/runtime/${DETERMINISTIC_RAPIER_WASM_FILE}`,
    activity.signal,
  );
  expect(simulateRoll).not.toHaveBeenCalled();
  readiness.resolve('ready');
  await expect(running).resolves.toBe(result);
});

test('propagates initialization and simulation failures', async () => {
  const failure = new Error('WASM unavailable');
  vi.mocked(initializeDeterministicRapierForBrowser).mockRejectedValueOnce(failure);
  await expect(runPhysicsDiagnostic(input)).rejects.toBe(failure);
  expect(simulateRoll).not.toHaveBeenCalled();
  const rejected = new Error('simulation rejected');
  vi.mocked(simulateRoll).mockRejectedValueOnce(rejected);
  await expect(runPhysicsDiagnostic(input)).rejects.toBe(rejected);
});

test('does not initialize an already cancelled diagnostic', async () => {
  const activity = new AbortController();
  const reason = new Error('replaced');
  activity.abort(reason);
  await expect(runPhysicsDiagnostic(input, activity.signal)).rejects.toBe(reason);
  expect(initializeDeterministicRapierForBrowser).not.toHaveBeenCalled();
  expect(simulateRoll).not.toHaveBeenCalled();
});

test('does not start simulation after cancellation during shared initialization', async () => {
  const readiness = deferred<string>();
  vi.mocked(initializeDeterministicRapierForBrowser).mockReturnValue(readiness.promise);
  const activity = new AbortController();
  const reason = new Error('replaced');
  const running = runPhysicsDiagnostic(input, activity.signal);
  activity.abort(reason);
  readiness.resolve('ready');
  await expect(running).rejects.toBe(reason);
  expect(simulateRoll).not.toHaveBeenCalled();
});

test('rejects a stale simulation result after cancellation', async () => {
  const calculation = deferred<SimulationResult>();
  vi.mocked(simulateRoll).mockReturnValue(calculation.promise);
  const activity = new AbortController();
  const running = runPhysicsDiagnostic(input, activity.signal);
  await Promise.resolve();
  expect(simulateRoll).toHaveBeenCalledOnce();
  const reason = new Error('replaced');
  activity.abort(reason);
  calculation.resolve(result);
  await expect(running).rejects.toBe(reason);
});
