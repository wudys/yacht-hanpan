import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { describe, expect, jest, spyOn, test } from 'bun:test';

import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import { ROLL_WORKER_GOLDEN_DIGEST, ROLL_WORKER_GOLDEN_INPUT } from '@/roll/roll-worker-golden';
import { WorkerRollSimulationExecutor } from '@/roll/worker-roll-simulation-executor';
import type { ServerErrorOperation } from '@/runtime/error-reporter';

const goldenInput = ROLL_WORKER_GOLDEN_INPUT;

describe('worker roll simulation executor', () => {
  test('reports a startup Error cause once across message, error and exit', async () => {
    process.env.ROLL_TEST_START_FAILURE = 'cause';
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await expect(executor.start()).rejects.toMatchObject({
        code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
      });
      expect(diagnostics.reports).toHaveLength(1);
      expect(diagnostics.reports[0]).toMatchObject({
        operation: 'worker.startup',
        error: {
          name: 'TypeError',
          message: 'test startup failure',
          cause: { name: 'RangeError' },
        },
      });
      expect((diagnostics.reports[0]?.error as Error).stack).toContain(
        'roll-simulation.test-worker.ts',
      );
    } finally {
      delete process.env.ROLL_TEST_START_FAILURE;
      await executor.close();
    }
    expect(diagnostics.reports).toHaveLength(1);
  });

  test('reports native worker error and exit as one incident', async () => {
    process.env.ROLL_TEST_START_FAILURE = 'native';
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await expect(executor.start()).rejects.toMatchObject({
        code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
      });
      expect(diagnostics.reports).toHaveLength(1);
      expect(diagnostics.reports[0]).toMatchObject({
        operation: 'worker.startup',
        error: { name: 'TypeError', message: 'test native startup failure' },
      });
    } finally {
      delete process.env.ROLL_TEST_START_FAILURE;
      await executor.close();
    }
    expect(diagnostics.reports).toHaveLength(1);
  });

  test('reports a golden mismatch once and preserves typed startup failure', async () => {
    process.env.ROLL_TEST_START_FAILURE = 'golden';
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await expect(executor.start()).rejects.toMatchObject({
        code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
      });
    } finally {
      delete process.env.ROLL_TEST_START_FAILURE;
      await executor.close();
    }
    expect(diagnostics.reports).toMatchObject([{ operation: 'worker.response', error: {} }]);
  });

  test('reports constructor failure and keeps the public startup result typed', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('https://invalid.example/worker.js'),
      reportUnexpected: diagnostics.report,
    });
    await expect(executor.start()).rejects.toMatchObject({
      code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
    });
    expect(diagnostics.reports).toMatchObject([{ operation: 'worker.startup', error: {} }]);
    expect(diagnostics.reports[0]?.error).toBeInstanceOf(Error);
    await executor.close();
  });

  test('reports two separate job causes and continues using the same worker', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: (error, operation) => {
        diagnostics.report(error, operation);
        throw new Error('test reporter failure');
      },
    });
    try {
      await executor.start();
      for (const seed of ['test-job-error-first', 'test-job-error-second']) {
        expect(await observe(executor.execute({ ...goldenInput, seed }))).toMatchObject({
          ok: false,
          error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
        });
      }
      expect(diagnostics.reports).toHaveLength(2);
      for (const report of diagnostics.reports) {
        expect(report.operation).toBe('worker.job');
        expect(report.error).toBeInstanceOf(Error);
        expect(report.error).toMatchObject({ name: 'TypeError', cause: { name: 'RangeError' } });
        expect((report.error as Error).stack).toContain('roll-simulation.test-worker.ts');
      }
      expect((await executor.execute(goldenInput)).replayDigest).toBe(ROLL_WORKER_GOLDEN_DIGEST);
      expect(executor.stats()).toMatchObject({
        readyWorkers: 1,
        running: 0,
        queued: 0,
        restarts: 0,
      });
    } finally {
      await executor.close();
    }
    expect(diagnostics.reports).toHaveLength(2);
  });

  test('does not report queue waiting expiry or closing its active worker', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      queueTimeoutMs: 30,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      const running = observe(executor.execute({ ...goldenInput, seed: 'test-hang' }));
      expect(await observe(executor.execute(goldenInput))).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(diagnostics.reports).toEqual([]);
      await executor.close();
      expect(await running).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
    } finally {
      await executor.close();
    }
    expect(diagnostics.reports).toEqual([]);
  });

  test('fails startup when a worker never becomes ready', async () => {
    const diagnostics = observeDiagnostics();
    process.env.ROLL_TEST_START_HANG = '1';
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      readyTimeoutMs: 100,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      const started = observe(executor.start());
      expect(await started).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(diagnostics.reports).toMatchObject([{ operation: 'worker.timeout', error: {} }]);
    } finally {
      delete process.env.ROLL_TEST_START_HANG;
      await executor.close();
      expect(diagnostics.reports).toHaveLength(1);
    }
  });

  test('settles pending startup when closed before its worker is ready', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    const started = observe(executor.start());
    try {
      await executor.close();
      expect(diagnostics.reports).toEqual([]);
      expect(await started).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
    } finally {
      await executor.close();
    }
  });

  test('warms a worker and executes the reviewed golden recipe', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      const result = await executor.execute(goldenInput);
      expect(result.replayDigest).toBe(ROLL_WORKER_GOLDEN_DIGEST);
      expect(result.authoritativeValuesBySlot).toEqual([{ slot: 0, value: 3 }]);
      expect(executor.stats()).toMatchObject({ readyWorkers: 1, running: 0, queued: 0 });
    } finally {
      await executor.close();
      expect(diagnostics.reports).toEqual([]);
    }
  });

  test('bounds the queue, rejects only the crashed job, and warms a replacement', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      const running = executor.execute({ ...goldenInput, seed: 'test-delay' });
      const queued = executor.execute({ ...goldenInput, seed: 'queued-after-delay' });
      await expect(executor.execute({ ...goldenInput, seed: 'overflow' })).rejects.toMatchObject({
        code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.CAPACITY,
      });
      await Promise.all([running, queued]);
      expect(diagnostics.reports).toEqual([]);

      const crashed = observe(executor.execute({ ...goldenInput, seed: 'test-crash' }));
      const surviving = observe(executor.execute(goldenInput));
      expect(executor.stats()).toMatchObject({ running: 1, queued: 1 });
      expect(await crashed).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(await surviving).toMatchObject({
        ok: true,
        value: { replayDigest: ROLL_WORKER_GOLDEN_DIGEST },
      });
      expect(executor.stats().restarts).toBe(1);
      expect(diagnostics.reports).toMatchObject([{ operation: 'worker.exit', error: {} }]);
    } finally {
      await executor.close();
      expect(diagnostics.reports).toHaveLength(1);
    }
  });

  test('rejects a malformed worker result and warms a replacement', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      expect(
        await observe(executor.execute({ ...goldenInput, seed: 'test-malformed' })),
      ).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      await waitFor(() => executor.stats().readyWorkers === 1);
      expect((await executor.execute(goldenInput)).replayDigest).toContain('sha256-q4-v2:');
      expect(executor.stats().restarts).toBe(1);
      expect(diagnostics.reports).toMatchObject([{ operation: 'worker.response', error: {} }]);
    } finally {
      await executor.close();
      expect(diagnostics.reports).toHaveLength(1);
    }
  });

  test('times out a hung job, replaces its worker, and runs queued work', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      jobTimeoutMs: 100,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      jest.useFakeTimers();
      const hung = observe(executor.execute({ ...goldenInput, seed: 'test-hang' }));
      const queued = executor.execute(goldenInput);

      jest.advanceTimersByTime(100);
      expect(await hung).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect((await queued).replayDigest).toContain('sha256-q4-v2:');
      expect(executor.stats()).toMatchObject({ readyWorkers: 1, restarts: 1 });
      expect(diagnostics.reports).toMatchObject([{ operation: 'worker.timeout', error: {} }]);
    } finally {
      await executor.close();
      jest.useRealTimers();
      expect(diagnostics.reports).toHaveLength(1);
    }
  });

  test('rejects pending jobs and makes concurrent close callers await worker termination', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    await executor.start();
    let finishTermination = () => {};
    const terminationGate = new Promise<void>((resolve) => {
      finishTermination = resolve;
    });
    const nativeTerminate = Worker.prototype.terminate;
    const terminate = spyOn(Worker.prototype, 'terminate').mockImplementation(function (
      this: Worker,
    ) {
      return terminationGate.then(() => nativeTerminate.call(this));
    });
    try {
      const observedRunning = observe(executor.execute({ ...goldenInput, seed: 'test-delay' }));
      const observedQueued = observe(executor.execute({ ...goldenInput, seed: 'queued-on-close' }));
      const closed: number[] = [];
      const first = executor.close().then(() => closed.push(1));
      const second = executor.close().then(() => closed.push(2));

      expect(await observedRunning).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(await observedQueued).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(closed).toEqual([]);

      finishTermination();
      await Promise.all([first, second]);
      expect(closed).toHaveLength(2);
      expect(executor.stats()).toEqual({ readyWorkers: 0, running: 0, queued: 0, restarts: 0 });
      expect(diagnostics.reports).toEqual([]);
    } finally {
      finishTermination();
      terminate.mockRestore();
      await executor.close();
    }
  });

  test('gives dispatched work its full execution budget after waiting in the queue', async () => {
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      queueTimeoutMs: 400,
      jobTimeoutMs: 400,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
    });
    try {
      await executor.start();
      // Advance the executor clock independently of native worker/WASM speed.
      jest.useFakeTimers();
      const running = executor.execute(goldenInput);
      const queued = observe(executor.execute(goldenInput));
      expect(executor.stats()).toMatchObject({ running: 1, queued: 1 });
      jest.advanceTimersByTime(399);
      await running;
      jest.advanceTimersByTime(399);
      expect(await queued).toMatchObject({
        ok: true,
        value: { replayDigest: ROLL_WORKER_GOLDEN_DIGEST },
      });
      expect(executor.stats()).toMatchObject({ running: 0, queued: 0, restarts: 0 });
    } finally {
      await executor.close();
      jest.useRealTimers();
    }
  });

  test('skips overdue work before its timer fires and dispatches the next queued job', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 2,
      queueTimeoutMs: 1_000,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      jest.useFakeTimers();
      const running = executor.execute({ ...goldenInput, seed: 'test-delay' });
      const queued = observe(executor.execute({ ...goldenInput, seed: 'test-crash' }));
      const now = spyOn(performance, 'now').mockReturnValue(performance.now() + 1_001);
      try {
        const laterQueued = executor.execute(goldenInput);
        await running;
        expect(await queued).toMatchObject({
          ok: false,
          error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
        });
        expect((await laterQueued).replayDigest).toContain('sha256-q4-v2:');
        expect(executor.stats()).toMatchObject({
          readyWorkers: 1,
          running: 0,
          queued: 0,
          restarts: 0,
        });
        expect(diagnostics.reports).toEqual([]);
      } finally {
        now.mockRestore();
      }
    } finally {
      await executor.close();
      jest.useRealTimers();
    }
  });

  test('expires queued work when worker replacements keep failing', async () => {
    const diagnostics = observeDiagnostics();
    const directory = mkdtempSync(join(tmpdir(), 'yacht-roll-worker-'));
    const attemptLog = join(directory, 'attempts.log');
    const previousAttemptLog = process.env.ROLL_TEST_REPLACEMENT_ATTEMPT_LOG;
    process.env.ROLL_TEST_REPLACEMENT_ATTEMPT_LOG = attemptLog;
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      queueTimeoutMs: 100,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      const running = observe(executor.execute({ ...goldenInput, seed: 'test-crash' }));
      const queued = observe(executor.execute({ ...goldenInput, seed: 'test-crash' }));
      expect(await running).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      await waitFor(() => attemptCount(attemptLog) >= 2);
      await waitFor(() =>
        diagnostics.reports.some((report) => report.operation === 'worker.startup'),
      );
      expect(
        diagnostics.reports.filter((report) => report.operation === 'worker.exit'),
      ).toHaveLength(1);
      expect(await queued).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(executor.stats()).toMatchObject({ readyWorkers: 0, running: 0, queued: 0 });
      const nextQueued = observe(executor.execute(goldenInput));
      expect(executor.stats().queued).toBe(1);
      expect(await nextQueued).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });

      rmSync(attemptLog);
      await waitFor(() => executor.stats().readyWorkers === 1);
      expect((await executor.execute(goldenInput)).replayDigest).toContain('sha256-q4-v2:');
      expect(executor.stats()).toMatchObject({ running: 0, queued: 0, restarts: 1 });
      expect(
        diagnostics.reports.every(
          (report) => report.operation === 'worker.exit' || report.operation === 'worker.startup',
        ),
      ).toBe(true);
    } finally {
      await executor.close();
      if (previousAttemptLog === undefined) delete process.env.ROLL_TEST_REPLACEMENT_ATTEMPT_LOG;
      else process.env.ROLL_TEST_REPLACEMENT_ATTEMPT_LOG = previousAttemptLog;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('does not retry a failed worker replacement after close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'yacht-roll-worker-'));
    const attemptLog = join(directory, 'attempts.log');
    process.env.ROLL_TEST_REPLACEMENT_ATTEMPT_LOG = attemptLog;
    const executor = new WorkerRollSimulationExecutor({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../test/fixtures/roll-simulation.test-worker.ts', import.meta.url),
    });

    try {
      await executor.start();
      await expect(executor.execute({ ...goldenInput, seed: 'test-crash' })).rejects.toBeInstanceOf(
        RollSimulationExecutorError,
      );
      await waitFor(() => attemptCount(attemptLog) >= 2);

      await executor.close();
      const attemptsAfterClose = attemptCount(attemptLog);
      await Bun.sleep(150);

      expect(attemptCount(attemptLog)).toBe(attemptsAfterClose);
    } finally {
      delete process.env.ROLL_TEST_REPLACEMENT_ATTEMPT_LOG;
      await executor.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function observeDiagnostics() {
  const reports: { error: unknown; operation: ServerErrorOperation }[] = [];
  return {
    reports,
    report: (error: unknown, operation: ServerErrorOperation): void => {
      reports.push({ error, operation });
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error('worker replacement timed out');
    await Bun.sleep(5);
  }
}

async function observe<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function attemptCount(path: string): number {
  return readFileSync(path, 'utf8').trim().split('\n').length;
}
