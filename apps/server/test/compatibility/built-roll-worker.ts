import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isSimulationOutcome, type SimulationOutcome } from '@repo/dice-simulation/contract';

import { ROLL_SIMULATION_EXECUTOR_ERROR_CODE } from '@/roll/roll-simulation-executor';
import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';
import {
  ROLL_WORKER_GOLDEN_DIGEST,
  ROLL_WORKER_GOLDEN_INPUT,
  ROLL_WORKER_GOLDEN_OUTCOME,
} from '@/roll/worker/roll-worker-golden';

export const builtWorkerUrl = new URL('../../dist/roll-simulation.worker.js', import.meta.url);

export async function assertGoldenResult(result: SimulationOutcome): Promise<void> {
  assert.ok(isSimulationOutcome(result));
  assert.deepEqual(result.input, ROLL_WORKER_GOLDEN_INPUT);
  assert.deepEqual(result.authoritativeValuesBySlot, ROLL_WORKER_GOLDEN_OUTCOME);
}

export async function verifyBuiltWorker(): Promise<void> {
  const normalReports: unknown[] = [];
  const executor = new RollSimulationWorkerPool({
    size: 1,
    maxQueued: 1,
    workerUrl: builtWorkerUrl,
    reportUnexpected: (error) => normalReports.push(error),
  });
  try {
    await executor.start();
    await assertGoldenResult(await executor.execute(ROLL_WORKER_GOLDEN_INPUT));
  } finally {
    await executor.close();
  }
  assert.deepEqual(executor.stats(), { readyWorkers: 0, running: 0, queued: 0, restarts: 0 });
  assert.equal(normalReports.length, 0);

  const directory = await mkdtemp(join(tmpdir(), 'built-roll-worker-'));
  // The wrapper injects only process exit. Boot, WASM, work and replacement all load the built artifact.
  const wrapper = join(directory, 'crash-worker.mjs');
  await Bun.write(
    wrapper,
    `import { parentPort } from 'node:worker_threads';
parentPort.on('message', request => {
  if (request.input.seed === 'compatibility-process-exit') process.exit(86);
});
await import(${JSON.stringify(builtWorkerUrl.href)});
`,
  );
  const crashReports: unknown[] = [];
  const replacement = new RollSimulationWorkerPool({
    size: 1,
    maxQueued: 1,
    workerUrl: pathToFileURL(wrapper),
    reportUnexpected: (error) => crashReports.push(error),
  });
  try {
    await replacement.start();
    const failed = replacement.execute({
      ...ROLL_WORKER_GOLDEN_INPUT,
      seed: 'compatibility-process-exit',
    });
    const rejection = assert.rejects(failed, {
      code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
    });
    const queued = replacement.execute(ROLL_WORKER_GOLDEN_INPUT);
    assert.equal(replacement.stats().queued, 1);
    await rejection;
    await assertGoldenResult(await queued);
    assert.deepEqual(replacement.stats(), { readyWorkers: 1, running: 0, queued: 0, restarts: 1 });
  } finally {
    await replacement.close();
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(replacement.stats(), { readyWorkers: 0, running: 0, queued: 0, restarts: 1 });
  assert.equal(crashReports.length, 1);
  await verifyBuiltWorkerCauses();
  console.log(
    JSON.stringify({
      builtWorker: builtWorkerUrl.pathname,
      golden: ROLL_WORKER_GOLDEN_DIGEST,
      crashRejected: true,
      queuedAfterReplacement: true,
      closedWorkers: 0,
      startupCauseReports: 1,
      separateJobCauseReports: 2,
    }),
  );
}

async function verifyBuiltWorkerCauses(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'built-worker-causes-'));
  try {
    // Inject only an IPC send failure; startup, simulation, catch and DTO use the built artifact.
    for (const phase of ['startup', 'job'] as const) {
      const wrapper = join(directory, `${phase}-worker.mjs`);
      await Bun.write(
        wrapper,
        `import { parentPort } from 'node:worker_threads';
const postMessage = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = message => {
  if (${JSON.stringify(phase)} === 'startup' ? message.kind === 'ready' :
      message.kind === 'result' && message.result.input.seed.startsWith('compatibility-cause-')) {
    throw new TypeError('PRIVATE_WORKER_CANARY', { cause: new RangeError('PRIVATE_WORKER_CAUSE_CANARY') });
  }
  return postMessage(message);
};
await import(${JSON.stringify(builtWorkerUrl.href)});
`,
      );
      const reports: unknown[] = [];
      const executor = new RollSimulationWorkerPool({
        size: 1,
        maxQueued: 1,
        workerUrl: pathToFileURL(wrapper),
        reportUnexpected: (error) => reports.push(error),
      });
      try {
        if (phase === 'startup') {
          await assert.rejects(executor.start(), {
            code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
          });
          assert.equal(reports.length, 1);
        } else {
          await executor.start();
          for (const seed of ['compatibility-cause-first', 'compatibility-cause-second']) {
            await assert.rejects(executor.execute({ ...ROLL_WORKER_GOLDEN_INPUT, seed }), {
              code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
            });
          }
          assert.equal(reports.length, 2);
          await assertGoldenResult(await executor.execute(ROLL_WORKER_GOLDEN_INPUT));
          assert.equal(executor.stats().restarts, 0);
        }
        for (const error of reports) {
          assert.ok(error instanceof Error);
          assert.equal(error.name, 'TypeError');
          assert.ok(error.cause instanceof Error);
          assert.equal(error.cause.name, 'RangeError');
          assert.match(error.stack ?? '', /roll-simulation\.worker\.ts:\d+:\d+/);
          assert.match(error.cause.stack ?? '', /roll-simulation\.worker\.ts:\d+:\d+/);
        }
      } finally {
        await executor.close();
      }
      assert.equal(reports.length, phase === 'startup' ? 1 : 2);
      assert.equal(executor.stats().readyWorkers, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
