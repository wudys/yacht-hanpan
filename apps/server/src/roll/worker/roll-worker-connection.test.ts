import { Worker } from 'node:worker_threads';

import { describe, expect, spyOn, test } from 'bun:test';

import { ROLL_SIMULATION_EXECUTOR_ERROR_CODE } from '@/roll/roll-simulation-executor';
import {
  RollWorkerConnection,
  type RollWorkerTerminal,
} from '@/roll/worker/roll-worker-connection';
import {
  ROLL_WORKER_GOLDEN_INPUT,
  ROLL_WORKER_GOLDEN_OUTCOME,
} from '@/roll/worker/roll-worker-golden';
import type { ServerErrorOperation } from '@/runtime/error-reporter';

const workerUrl = new URL(
  '../../../test/fixtures/roll-simulation-fault.worker.ts',
  import.meta.url,
);

describe('roll worker connection', () => {
  test('shares readiness and ignores an unmatched job response before settling the active job', async () => {
    const reports: ServerErrorOperation[] = [];
    const terminal: RollWorkerTerminal[] = [];
    const connection = new RollWorkerConnection({
      workerUrl,
      readyTimeoutMs: 1_000,
      reportUnexpected: (_error, operation) => reports.push(operation),
      onTerminal: (_connection, event) => terminal.push(event),
    });
    try {
      const first = connection.start();
      expect(connection.start()).toBe(first);
      await first;
      const input = { ...ROLL_WORKER_GOLDEN_INPUT, seed: 'test-wrong-id' };
      expect((await connection.run(1, input)).input).toEqual(input);
      expect((await connection.run(2, ROLL_WORKER_GOLDEN_INPUT)).authoritativeValuesBySlot).toEqual(
        ROLL_WORKER_GOLDEN_OUTCOME,
      );
      expect(reports).toEqual([]);
      expect(terminal).toEqual([]);
    } finally {
      await connection.close();
    }
    expect(terminal).toEqual([{ intentional: true, warmed: true }]);
    expect(reports).toEqual([]);
  });

  test('settles startup immediately on close while all close callers await one termination', async () => {
    const terminal: RollWorkerTerminal[] = [];
    const reports: ServerErrorOperation[] = [];
    const connection = new RollWorkerConnection({
      workerUrl,
      readyTimeoutMs: 1_000,
      reportUnexpected: (_error, operation) => reports.push(operation),
      onTerminal: (_connection, event) => terminal.push(event),
    });
    let finishTermination = () => {};
    const gate = new Promise<void>((resolve) => {
      finishTermination = resolve;
    });
    const nativeTerminate = Worker.prototype.terminate;
    const terminate = spyOn(Worker.prototype, 'terminate').mockImplementation(function (
      this: Worker,
    ) {
      return gate.then(() => nativeTerminate.call(this));
    });
    try {
      const startup = connection.start().catch((error: unknown) => error);
      const first = connection.close();
      expect(connection.close()).toBe(first);
      expect(await startup).toMatchObject({
        code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
      });
      expect(terminal).toEqual([]);
      expect(terminate).toHaveBeenCalledTimes(1);
      finishTermination();
      await first;
      expect(terminal).toEqual([{ intentional: true, warmed: false }]);
      expect(reports).toEqual([]);
    } finally {
      finishTermination();
      terminate.mockRestore();
      await connection.close();
    }
  });

  test('shares termination with a reentrant diagnostic close and reports the first cause once', async () => {
    const reports: { error: unknown; operation: ServerErrorOperation }[] = [];
    const terminal: RollWorkerTerminal[] = [];
    let closedDuringReport: Promise<void> | null = null;
    const connection = new RollWorkerConnection({
      workerUrl,
      readyTimeoutMs: 1_000,
      reportUnexpected: (error, operation) => {
        reports.push({ error, operation });
        closedDuringReport = connection.close();
      },
      onTerminal: (_connection, event) => terminal.push(event),
    });
    const terminate = spyOn(Worker.prototype, 'terminate');
    try {
      await connection.start();
      const job = connection
        .run(1, { ...ROLL_WORKER_GOLDEN_INPUT, seed: 'test-hang' })
        .catch((error: unknown) => error);
      const cause = new Error('test job deadline');
      connection.terminate({ error: cause, operation: 'worker.timeout' });
      connection.terminate({ error: new Error('later cause'), operation: 'worker.exit' });
      expect(Object.is(connection.close(), closedDuringReport)).toBe(true);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(await job).toMatchObject({
        code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
      });
      await connection.close();
      expect(reports).toEqual([{ error: cause, operation: 'worker.timeout' }]);
      expect(terminal).toEqual([{ intentional: false, warmed: true }]);
    } finally {
      terminate.mockRestore();
      await connection.close();
    }
  });
});
