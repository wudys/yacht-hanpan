import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import type { RollCandidateEvaluation, SimulationOutcome } from '@repo/dice-simulation/contract';
import { describe, expect, jest, spyOn, test } from 'bun:test';

import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';
import {
  ROLL_WORKER_GOLDEN_INPUT,
  ROLL_WORKER_GOLDEN_OUTCOME,
} from '@/roll/worker/roll-worker-golden';
import type { ServerErrorOperation } from '@/runtime/error-reporter';

const goldenInput = ROLL_WORKER_GOLDEN_INPUT;

describe('worker roll simulation executor', () => {
  test('settles expired queued work even when its diagnostic throws', async () => {
    let now = 0;
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      queueTimeoutMs: 100,
      monotonicNow: () => now,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      logger: {
        debug() {},
        info() {},
        error() {},
        warn() {
          throw new Error('diagnostic failure');
        },
      },
    });
    try {
      await executor.start();
      jest.useFakeTimers();
      const running = observe(executor.execute({ ...goldenInput, seed: 'test-hang' }, budget()));
      const queued = observe(executor.execute(goldenInput, budget()));
      now = 100;
      expect(() => jest.advanceTimersByTime(100)).not.toThrow();
      expect(await Promise.race([queued, Bun.sleep(200).then(() => 'pending')])).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(executor.stats().queued).toBe(0);
      await executor.close();
      expect(await running).toMatchObject({ ok: false });
    } finally {
      await executor.close();
      jest.useRealTimers();
    }
  });

  test('settles completed and following queued work even when its diagnostic throws', async () => {
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      logger: {
        debug() {
          throw new Error('diagnostic failure');
        },
        info() {},
        error() {},
        warn() {},
      },
    });
    try {
      await executor.start();
      const first = observe(executor.execute(goldenInput, budget()));
      const next = observe(executor.execute(goldenInput, budget()));
      expect(
        await Promise.race([Promise.all([first, next]), Bun.sleep(1_000).then(() => 'pending')]),
      ).toMatchObject([
        { ok: true, value: { status: 'accepted' } },
        { ok: true, value: { status: 'accepted' } },
      ]);
      expect(executor.stats()).toMatchObject({ running: 0, queued: 0, restarts: 0 });
    } finally {
      await executor.close();
    }
  });

  test('reports a startup Error cause once across message, error and exit', async () => {
    process.env.ROLL_TEST_START_FAILURE = 'cause';
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
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
        'roll-simulation-fault.worker.ts',
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
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
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
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
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
    const executor = new RollSimulationWorkerPool({
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
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      reportUnexpected: (error, operation) => {
        diagnostics.report(error, operation);
        throw new Error('test reporter failure');
      },
    });
    try {
      await executor.start();
      for (const seed of ['test-job-error-first', 'test-job-error-second']) {
        expect(await observe(executor.execute({ ...goldenInput, seed }, budget()))).toMatchObject({
          ok: false,
          error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
        });
      }
      expect(diagnostics.reports).toHaveLength(2);
      for (const report of diagnostics.reports) {
        expect(report.operation).toBe('worker.job');
        expect(report.error).toBeInstanceOf(Error);
        expect(report.error).toMatchObject({ name: 'TypeError', cause: { name: 'RangeError' } });
        expect((report.error as Error).stack).toContain('roll-simulation-fault.worker.ts');
      }
      expect(
        acceptedOutcome(await executor.execute(goldenInput, budget())).authoritativeValuesBySlot,
      ).toEqual(ROLL_WORKER_GOLDEN_OUTCOME);
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

  test('treats a quality rejection as a normal result and keeps its worker reusable', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      const input = { ...goldenInput, seed: 'test-quality-rejection' };
      expect(await executor.execute(input, budget())).toEqual({
        status: 'rejected',
        input,
        reason: 'stable-stack',
        simulationMs: 2000,
      });
      expect(
        acceptedOutcome(await executor.execute(goldenInput, budget())).authoritativeValuesBySlot,
      ).toEqual(ROLL_WORKER_GOLDEN_OUTCOME);
      expect(executor.stats()).toMatchObject({
        readyWorkers: 1,
        running: 0,
        queued: 0,
        restarts: 0,
      });
      expect(diagnostics.reports).toEqual([]);
    } finally {
      await executor.close();
    }
  });

  test('does not report queue waiting expiry or closing its active worker', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      queueTimeoutMs: 30,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      const running = observe(executor.execute({ ...goldenInput, seed: 'test-hang' }, budget()));
      expect(await observe(executor.execute(goldenInput, budget()))).toMatchObject({
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
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      readyTimeoutMs: 100,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
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
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
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
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      const result = acceptedOutcome(await executor.execute(goldenInput, budget()));
      expect(result.authoritativeValuesBySlot).toEqual(ROLL_WORKER_GOLDEN_OUTCOME);
      expect(executor.stats()).toMatchObject({ readyWorkers: 1, running: 0, queued: 0 });
    } finally {
      await executor.close();
      expect(diagnostics.reports).toEqual([]);
    }
  });

  test('bounds the queue, rejects only the crashed job, and warms a replacement', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      const running = executor.execute({ ...goldenInput, seed: 'test-delay' }, budget());
      const queued = executor.execute({ ...goldenInput, seed: 'queued-after-delay' }, budget());
      await expect(
        executor.execute({ ...goldenInput, seed: 'overflow' }, budget()),
      ).rejects.toMatchObject({
        code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.CAPACITY,
      });
      await Promise.all([running, queued]);
      expect(diagnostics.reports).toEqual([]);

      const crashed = observe(executor.execute({ ...goldenInput, seed: 'test-crash' }, budget()));
      const surviving = observe(executor.execute(goldenInput, budget()));
      expect(executor.stats()).toMatchObject({ running: 1, queued: 1 });
      expect(await crashed).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(await surviving).toMatchObject({
        ok: true,
        value: {
          status: 'accepted',
          outcome: { authoritativeValuesBySlot: ROLL_WORKER_GOLDEN_OUTCOME },
        },
      });
      expect(executor.stats().restarts).toBe(1);
      expect(diagnostics.reports).toMatchObject([{ operation: 'worker.exit', error: {} }]);
    } finally {
      await executor.close();
      expect(diagnostics.reports).toHaveLength(1);
    }
  });

  test.each([
    'test-malformed',
    'test-malformed-sparse',
    'test-malformed-face',
    'test-malformed-slot',
  ])('rejects malformed compact response %s and warms a replacement', async (seed) => {
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      expect(await observe(executor.execute({ ...goldenInput, seed }, budget()))).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      await waitFor(() => executor.stats().readyWorkers === 1);
      expect(
        acceptedOutcome(await executor.execute(goldenInput, budget())).authoritativeValuesBySlot,
      ).toEqual(ROLL_WORKER_GOLDEN_OUTCOME);
      expect(executor.stats().restarts).toBe(1);
      expect(diagnostics.reports).toMatchObject([{ operation: 'worker.response', error: {} }]);
    } finally {
      await executor.close();
      expect(diagnostics.reports).toHaveLength(1);
    }
  });

  test('times out a hung job, replaces its worker, and runs queued work', async () => {
    let now = 0;
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      jobTimeoutMs: 100,
      monotonicNow: () => now,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
      logger: {
        debug() {},
        info() {},
        error() {},
        warn() {
          throw new Error('diagnostic failure');
        },
      },
    });
    try {
      await executor.start();
      jest.useFakeTimers();
      const hung = observe(executor.execute({ ...goldenInput, seed: 'test-hang' }, budget()));
      const queued = executor.execute(goldenInput, budget());

      now = 100;
      jest.advanceTimersByTime(100);
      expect(await hung).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(acceptedOutcome(await queued).authoritativeValuesBySlot).toEqual(
        ROLL_WORKER_GOLDEN_OUTCOME,
      );
      expect(executor.stats()).toMatchObject({ readyWorkers: 1, restarts: 1 });
      expect(diagnostics.reports).toMatchObject([{ operation: 'worker.timeout', error: {} }]);
    } finally {
      await executor.close();
      jest.useRealTimers();
      expect(diagnostics.reports).toHaveLength(1);
    }
  });

  test.each([80, 100])(
    'replenishes budget-expired workers without reporting a fault (%sms)',
    async (duration) => {
      let now = 0;
      const diagnostics = observeDiagnostics();
      const executor = new RollSimulationWorkerPool({
        size: 1,
        maxQueued: 1,
        jobTimeoutMs: 100,
        monotonicNow: () => now,
        workerUrl: new URL(
          '../../../test/fixtures/roll-simulation-fault.worker.ts',
          import.meta.url,
        ),
        reportUnexpected: diagnostics.report,
      });
      try {
        await executor.start();
        jest.useFakeTimers();
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const hung = observe(
            executor.execute({ ...goldenInput, seed: 'test-hang' }, { deadlineMs: now + duration }),
          );
          const queued = executor.execute(goldenInput, { deadlineMs: now + 10_000 });
          now += duration;
          jest.advanceTimersByTime(duration);
          expect(await hung).toMatchObject({
            ok: false,
            error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
          });
          expect(acceptedOutcome(await queued).authoritativeValuesBySlot).toEqual(
            ROLL_WORKER_GOLDEN_OUTCOME,
          );
          expect(executor.stats()).toMatchObject({
            readyWorkers: 1,
            running: 0,
            queued: 0,
            restarts: attempt + 1,
          });
        }
        expect(diagnostics.reports).toEqual([]);
      } finally {
        await executor.close();
        jest.useRealTimers();
      }
      expect(executor.stats()).toEqual({ readyWorkers: 0, running: 0, queued: 0, restarts: 2 });
    },
  );

  test('rechecks the clock when queue and job timers wake before their local caps', async () => {
    let now = 0;
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      jobTimeoutMs: 100,
      queueTimeoutMs: 100,
      monotonicNow: () => now,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      jest.useFakeTimers();
      const running = observe(
        executor.execute({ ...goldenInput, seed: 'test-hang' }, { deadlineMs: 15_000 }),
      );
      const queued = observe(executor.execute(goldenInput, { deadlineMs: 15_000 }));
      now = 99;
      jest.advanceTimersByTime(100);
      expect(executor.stats()).toMatchObject({ running: 1, queued: 1, restarts: 0 });
      expect(diagnostics.reports).toEqual([]);
      now = 100;
      jest.advanceTimersByTime(1);
      expect(await running).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(await queued).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      jest.useRealTimers();
      await waitFor(() => executor.stats().readyWorkers === 1);
      expect(executor.stats()).toMatchObject({ running: 0, queued: 0, restarts: 1 });
      expect(diagnostics.reports).toMatchObject([{ operation: 'worker.timeout' }]);
    } finally {
      await executor.close();
      jest.useRealTimers();
    }
  });

  test.each([200, 260])(
    'treats a delayed watchdog callback after the shared deadline as expected expiry (%sms)',
    async (elapsed) => {
      let now = 0;
      const diagnostics = observeDiagnostics();
      const executor = new RollSimulationWorkerPool({
        size: 1,
        maxQueued: 1,
        jobTimeoutMs: 100,
        monotonicNow: () => now,
        workerUrl: new URL(
          '../../../test/fixtures/roll-simulation-fault.worker.ts',
          import.meta.url,
        ),
        reportUnexpected: diagnostics.report,
      });
      try {
        await executor.start();
        jest.useFakeTimers();
        const hung = observe(
          executor.execute({ ...goldenInput, seed: 'test-hang' }, { deadlineMs: 200 }),
        );
        // The event loop reaches the 100ms watchdog only after the command deadline.
        now = elapsed;
        jest.advanceTimersByTime(100);
        expect(await hung).toMatchObject({
          ok: false,
          error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
        });
        expect(diagnostics.reports).toEqual([]);
        jest.useRealTimers();
        await waitFor(() => executor.stats().readyWorkers === 1);
        expect(executor.stats()).toMatchObject({
          readyWorkers: 1,
          running: 0,
          queued: 0,
          restarts: 1,
        });
      } finally {
        await executor.close();
        jest.useRealTimers();
      }
    },
  );

  test('rejects pending jobs and makes concurrent close callers await worker termination', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
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
      const observedRunning = observe(
        executor.execute({ ...goldenInput, seed: 'test-delay' }, budget()),
      );
      const observedQueued = observe(
        executor.execute({ ...goldenInput, seed: 'queued-on-close' }, budget()),
      );
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

  test('uses only the command budget remaining after queue waiting', async () => {
    let now = 0;
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      queueTimeoutMs: 400,
      jobTimeoutMs: 400,
      monotonicNow: () => now,
      reportUnexpected: diagnostics.report,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
    });
    try {
      await executor.start();
      jest.useFakeTimers();
      const running = executor.execute(goldenInput, { deadlineMs: 10_000 });
      const queued = observe(
        executor.execute({ ...goldenInput, seed: 'test-hang' }, { deadlineMs: 400 }),
      );
      now = 399;
      jest.advanceTimersByTime(399);
      await running;
      now = 400;
      jest.advanceTimersByTime(1);
      expect(await queued).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      jest.useRealTimers();
      await waitFor(() => executor.stats().readyWorkers === 1);
      expect(executor.stats()).toMatchObject({ running: 0, queued: 0, restarts: 1 });
      expect(diagnostics.reports).toEqual([]);
    } finally {
      await executor.close();
      jest.useRealTimers();
    }
  });

  test('rejects an expired budget before admission, including when the queue is full', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 0,
      monotonicNow: () => 100,
      reportUnexpected: diagnostics.report,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
    });
    try {
      await executor.start();
      expect(await observe(executor.execute(goldenInput, { deadlineMs: 100 }))).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      const running = observe(
        executor.execute({ ...goldenInput, seed: 'test-hang' }, { deadlineMs: 10_000 }),
      );
      expect(await observe(executor.execute(goldenInput, { deadlineMs: 99 }))).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });
      expect(executor.stats()).toMatchObject({ running: 1, queued: 0, restarts: 0 });
      await executor.close();
      await running;
      expect(diagnostics.reports).toEqual([]);
    } finally {
      await executor.close();
    }
  });

  test.each([
    { elapsed: 9_999, deadlineMs: 15_000, accepted: true, localTimeout: false },
    { elapsed: 10_000, deadlineMs: 15_000, accepted: false, localTimeout: true },
    { elapsed: 10_001, deadlineMs: 15_000, accepted: false, localTimeout: true },
    { elapsed: 9_000, deadlineMs: 9_000, accepted: false, localTimeout: false },
    { elapsed: 10_000, deadlineMs: 10_000, accepted: false, localTimeout: false },
    { elapsed: 15_001, deadlineMs: 15_000, accepted: false, localTimeout: false },
  ])(
    'checks both deadlines before accepting a result that precedes its watchdog: %p',
    async ({ elapsed, deadlineMs, accepted, localTimeout }) => {
      let now = 0;
      const diagnostics = observeDiagnostics();
      const logs: { event: string; fields: unknown }[] = [];
      const executor = new RollSimulationWorkerPool({
        size: 1,
        maxQueued: 1,
        monotonicNow: () => now,
        reportUnexpected: diagnostics.report,
        logger: {
          debug: (event, fields) => logs.push({ event, fields }),
          warn: (event, fields) => logs.push({ event, fields }),
          info() {},
          error() {},
        },
        workerUrl: new URL(
          '../../../test/fixtures/roll-simulation-fault.worker.ts',
          import.meta.url,
        ),
      });
      try {
        await executor.start();
        jest.useFakeTimers();
        const late = observe(executor.execute(goldenInput, { deadlineMs }));
        now = elapsed;
        expect(await late).toMatchObject(
          accepted
            ? { ok: true, value: { status: 'accepted' } }
            : { ok: false, error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE } },
        );
        expect(logs.filter(({ event }) => event === 'roll_worker_timed_out')).toHaveLength(
          localTimeout ? 1 : 0,
        );
        expect(logs.find(({ event }) => event === 'roll_worker_completed')?.fields).toEqual({
          jobElapsedMs: elapsed,
        });
        const next = executor.execute(goldenInput, { deadlineMs: now + 15_000 });
        jest.advanceTimersByTime(10_000);
        expect(acceptedOutcome(await next).authoritativeValuesBySlot).toEqual(
          ROLL_WORKER_GOLDEN_OUTCOME,
        );
        expect(executor.stats()).toMatchObject({
          readyWorkers: 1,
          running: 0,
          queued: 0,
          restarts: 0,
        });
        expect(diagnostics.reports).toEqual([]);
      } finally {
        await executor.close();
        jest.useRealTimers();
      }
    },
  );

  test('skips overdue work before its timer fires and dispatches the next queued job', async () => {
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 2,
      queueTimeoutMs: 1_000,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
    });
    try {
      await executor.start();
      jest.useFakeTimers();
      const running = executor.execute({ ...goldenInput, seed: 'test-delay' }, budget());
      const queued = observe(executor.execute({ ...goldenInput, seed: 'test-crash' }, budget()));
      const now = spyOn(performance, 'now').mockReturnValue(performance.now() + 1_001);
      try {
        const laterQueued = executor.execute(goldenInput, budget());
        await running;
        expect(await queued).toMatchObject({
          ok: false,
          error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
        });
        expect(acceptedOutcome(await laterQueued).authoritativeValuesBySlot).toEqual(
          ROLL_WORKER_GOLDEN_OUTCOME,
        );
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

  test.each([
    { elapsed: 99, deadlineMs: 150, accepted: true, localTimeout: false },
    { elapsed: 100, deadlineMs: 150, accepted: false, localTimeout: true },
    { elapsed: 50, deadlineMs: 50, accepted: false, localTimeout: false },
    { elapsed: 100, deadlineMs: 100, accepted: false, localTimeout: false },
  ])(
    'checks queue deadlines before dispatch when its timer has not fired: %p',
    async ({ elapsed, deadlineMs, accepted, localTimeout }) => {
      let now = 0;
      const diagnostics = observeDiagnostics();
      const logs: string[] = [];
      const executor = new RollSimulationWorkerPool({
        size: 1,
        maxQueued: 2,
        queueTimeoutMs: 100,
        monotonicNow: () => now,
        workerUrl: new URL(
          '../../../test/fixtures/roll-simulation-fault.worker.ts',
          import.meta.url,
        ),
        reportUnexpected: diagnostics.report,
        logger: { debug() {}, info() {}, error() {}, warn: (event) => logs.push(event) },
      });
      try {
        await executor.start();
        jest.useFakeTimers();
        const running = executor.execute(goldenInput, { deadlineMs: 10_000 });
        const expired = observe(executor.execute(goldenInput, { deadlineMs }));
        now = elapsed;
        const later = executor.execute(goldenInput, { deadlineMs: 10_000 });
        await running;
        expect(await expired).toMatchObject(
          accepted
            ? { ok: true, value: { status: 'accepted' } }
            : { ok: false, error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE } },
        );
        expect(logs).toEqual(localTimeout ? ['roll_worker_queue_timed_out'] : []);
        expect(acceptedOutcome(await later).authoritativeValuesBySlot).toEqual(
          ROLL_WORKER_GOLDEN_OUTCOME,
        );
        expect(executor.stats()).toMatchObject({
          running: 0,
          queued: 0,
          readyWorkers: 1,
          restarts: 0,
        });
        expect(diagnostics.reports).toEqual([]);
      } finally {
        await executor.close();
        jest.useRealTimers();
      }
    },
  );

  test('does not replace a budget-expired connection when close races its termination', async () => {
    let now = 0;
    const diagnostics = observeDiagnostics();
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      monotonicNow: () => now,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
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
      jest.useFakeTimers();
      const running = observe(
        executor.execute({ ...goldenInput, seed: 'test-hang' }, { deadlineMs: 100 }),
      );
      now = 100;
      jest.advanceTimersByTime(100);
      expect(await running).toMatchObject({ ok: false });
      const closed = executor.close();
      finishTermination();
      await closed;
      expect(executor.stats()).toEqual({ readyWorkers: 0, running: 0, queued: 0, restarts: 0 });
      expect(diagnostics.reports).toEqual([]);
    } finally {
      finishTermination();
      terminate.mockRestore();
      await executor.close();
      jest.useRealTimers();
    }
  });

  test('retains the original watchdog fault when its reporter closes the pool reentrantly', async () => {
    let now = 0;
    const diagnostics = observeDiagnostics();
    let closed: Promise<void> | undefined;
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      jobTimeoutMs: 100,
      monotonicNow: () => now,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      reportUnexpected: (error, operation) => {
        diagnostics.report(error, operation);
        closed = executor.close();
      },
    });
    try {
      await executor.start();
      jest.useFakeTimers();
      const running = observe(executor.execute({ ...goldenInput, seed: 'test-hang' }, budget()));
      now = 100;
      jest.advanceTimersByTime(100);
      expect(await running).toMatchObject({ ok: false });
      expect(closed).toBeDefined();
      await closed;
      expect(executor.stats()).toEqual({ readyWorkers: 0, running: 0, queued: 0, restarts: 0 });
      expect(diagnostics.reports).toMatchObject([{ operation: 'worker.timeout', error: {} }]);
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
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      queueTimeoutMs: 100,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
      reportUnexpected: diagnostics.report,
      logger: {
        debug() {},
        info() {},
        error() {
          throw new Error('diagnostic failure');
        },
        warn() {
          throw new Error('diagnostic failure');
        },
      },
    });
    try {
      await executor.start();
      const running = observe(executor.execute({ ...goldenInput, seed: 'test-crash' }, budget()));
      const queued = observe(executor.execute({ ...goldenInput, seed: 'test-crash' }, budget()));
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
      const nextQueued = observe(executor.execute(goldenInput, budget()));
      expect(executor.stats().queued).toBe(1);
      expect(await nextQueued).toMatchObject({
        ok: false,
        error: { code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE },
      });

      rmSync(attemptLog);
      await waitFor(() => executor.stats().readyWorkers === 1);
      expect(
        acceptedOutcome(await executor.execute(goldenInput, budget())).authoritativeValuesBySlot,
      ).toEqual(ROLL_WORKER_GOLDEN_OUTCOME);
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
    const executor = new RollSimulationWorkerPool({
      size: 1,
      maxQueued: 1,
      workerUrl: new URL('../../../test/fixtures/roll-simulation-fault.worker.ts', import.meta.url),
    });

    try {
      await executor.start();
      await expect(
        executor.execute({ ...goldenInput, seed: 'test-crash' }, budget()),
      ).rejects.toBeInstanceOf(RollSimulationExecutorError);
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

function budget() {
  return { deadlineMs: performance.now() + 30_000 };
}

function acceptedOutcome(candidate: RollCandidateEvaluation): SimulationOutcome {
  expect(candidate.status).toBe('accepted');
  if (candidate.status !== 'accepted') throw new Error('Expected accepted fixture');
  return candidate.outcome;
}
