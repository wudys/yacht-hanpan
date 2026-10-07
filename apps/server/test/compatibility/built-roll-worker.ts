import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  isRollCandidateEvaluation,
  type RollCandidateEvaluation,
} from '@repo/dice-simulation/contract';
import { createCompatibilityContract } from '@repo/game-protocol/version';

import { createAuthoritativeRollCommandExecutor } from '@/roll/authoritative-roll-command-executor';
import { ROLL_SIMULATION_EXECUTOR_ERROR_CODE } from '@/roll/roll-simulation-executor';
import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';
import {
  ROLL_WORKER_GOLDEN_DIGEST,
  ROLL_WORKER_GOLDEN_INPUT,
  ROLL_WORKER_GOLDEN_OUTCOME,
} from '@/roll/worker/roll-worker-golden';

export const builtWorkerUrl = new URL('../../dist/roll-simulation.worker.js', import.meta.url);

export async function assertGoldenResult(result: RollCandidateEvaluation): Promise<void> {
  assert.ok(isRollCandidateEvaluation(result));
  assert.ok(result.status === 'accepted');
  assert.deepEqual(result.outcome.input, ROLL_WORKER_GOLDEN_INPUT);
  assert.deepEqual(result.outcome.authoritativeValuesBySlot, ROLL_WORKER_GOLDEN_OUTCOME);
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
    await assertGoldenResult(
      await executor.execute(ROLL_WORKER_GOLDEN_INPUT, { deadlineMs: performance.now() + 10_000 }),
    );
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
    const failed = replacement.execute(
      {
        ...ROLL_WORKER_GOLDEN_INPUT,
        seed: 'compatibility-process-exit',
      },
      { deadlineMs: performance.now() + 10_000 },
    );
    const rejection = assert.rejects(failed, {
      code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
    });
    const queued = replacement.execute(ROLL_WORKER_GOLDEN_INPUT, {
      deadlineMs: performance.now() + 10_000,
    });
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
  await verifyBuiltAuthorityReseeding();
  await verifyBuiltWorkerCandidateRejections();
  await verifyBuiltWorkerBudgetExpiry();
  await verifyBuiltWorkerCauses();
  console.log(
    JSON.stringify({
      builtWorker: builtWorkerUrl.pathname,
      golden: ROLL_WORKER_GOLDEN_DIGEST,
      crashRejected: true,
      queuedAfterReplacement: true,
      nativeAuthorityReseedAccepted: true,
      candidateRejectedWithoutRestart: true,
      budgetExpiredRejected: true,
      queuedAfterBudgetReplacement: true,
      closedWorkers: 0,
      startupCauseReports: 1,
      separateJobCauseReports: 2,
    }),
  );
}

async function verifyBuiltAuthorityReseeding(): Promise<void> {
  const reports: unknown[] = [];
  const failures: unknown[] = [];
  const pool = new RollSimulationWorkerPool({
    size: 1,
    maxQueued: 1,
    workerUrl: builtWorkerUrl,
    reportUnexpected: (error) => reports.push(error),
  });
  const seeds = ['21f806f9d20df7231635b433a1dc99aa', 'ad8a8e1d054b30cb5f30ec3ca4ed8754'];
  let createdSeeds = 0;
  let createdIds = 0;
  let createdStyles = 0;
  const inputs: string[] = [];
  const authority = createAuthoritativeRollCommandExecutor({
    executionBudgetMs: 10_000,
    contract: createCompatibilityContract('built-reseed-test'),
    logger: { error: (event) => failures.push(event) },
    reportUnexpected: (error) => reports.push(error),
    recipeSource: {
      createRollId: () => {
        createdIds += 1;
        return '8184fc0a-4e59-455d-a7c1-579a9ee96403';
      },
      createPourStyle: () => {
        createdStyles += 1;
        return 'burst';
      },
      createRollSeed: () => {
        const seed = seeds[createdSeeds++];
        if (seed === undefined) throw new Error('Unexpected extra candidate');
        return seed;
      },
    },
    simulation: {
      execute: (input, budget) => {
        inputs.push(JSON.stringify(input));
        return pool.execute(input, budget);
      },
    },
  });
  try {
    await pool.start();
    const result = await authority.execute({ rolledSlots: [0, 1, 2, 3] });
    assert.ok(result.ok);
    assert.equal(createdSeeds, 2);
    assert.equal(createdIds, 1);
    assert.equal(createdStyles, 1);
    assert.deepEqual(
      inputs.map((input) => JSON.parse(input)),
      seeds.map((seed) => ({
        rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
        seed,
        pourStyle: 'burst',
        rolledSlots: [0, 1, 2, 3],
      })),
    );
    assert.equal(result.artifact.replay.seed, seeds[1]);
    assert.equal(result.artifact.replay.pourStyle, 'burst');
    assert.deepEqual(result.artifact.replay.rolledSlots, [0, 1, 2, 3]);
    assert.deepEqual(result.artifact.outcome.authoritativeValuesBySlot, [
      { slot: 0, value: 1 },
      { slot: 1, value: 5 },
      { slot: 2, value: 4 },
      { slot: 3, value: 4 },
    ]);
    assert.equal(JSON.stringify(result).includes(seeds[0]!), false);
    assert.deepEqual(reports, []);
    assert.deepEqual(failures, []);
    assert.deepEqual(pool.stats(), { readyWorkers: 1, running: 0, queued: 0, restarts: 0 });
  } finally {
    await pool.close();
  }
  assert.deepEqual(pool.stats(), { readyWorkers: 0, running: 0, queued: 0, restarts: 0 });
}

async function verifyBuiltWorkerCandidateRejections(): Promise<void> {
  const reports: unknown[] = [];
  const executor = new RollSimulationWorkerPool({
    size: 1,
    maxQueued: 1,
    workerUrl: builtWorkerUrl,
    reportUnexpected: (error) => reports.push(error),
  });
  try {
    await executor.start();
    // Independent r900 regression inputs verify real built/WASM rejection IPC.
    for (const fixture of [
      {
        seed: '21f806f9d20df7231635b433a1dc99aa',
        pourStyle: 'burst',
        rolledSlots: [0, 1, 2, 3],
        reason: 'stable-stack',
        simulationMs: 2567,
      },
      {
        seed: 'd71d816244d19bcfe1cc4af2be4ded05',
        pourStyle: 'oblique',
        rolledSlots: [0, 1, 2],
        reason: 'repeated-assist',
        simulationMs: 3300,
      },
    ] as const) {
      const input = {
        rollId: 'built-candidate-regression',
        seed: fixture.seed,
        pourStyle: fixture.pourStyle,
        rolledSlots: fixture.rolledSlots,
      };
      assert.deepEqual(await executor.execute(input, { deadlineMs: performance.now() + 10_000 }), {
        status: 'rejected',
        input,
        reason: fixture.reason,
        simulationMs: fixture.simulationMs,
      });
    }
    await assertGoldenResult(
      await executor.execute(ROLL_WORKER_GOLDEN_INPUT, { deadlineMs: performance.now() + 10_000 }),
    );
    assert.deepEqual(executor.stats(), { readyWorkers: 1, running: 0, queued: 0, restarts: 0 });
    assert.equal(reports.length, 0);
  } finally {
    await executor.close();
  }
  assert.deepEqual(executor.stats(), { readyWorkers: 0, running: 0, queued: 0, restarts: 0 });
}

async function verifyBuiltWorkerBudgetExpiry(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'built-worker-budget-'));
  const wrapper = join(directory, 'budget-worker.mjs');
  // Block the native worker CPU; only a real termination can release this job.
  await Bun.write(
    wrapper,
    `import { parentPort } from 'node:worker_threads';
parentPort.on('message', request => {
  if (request.input.seed === 'compatibility-budget-hang') { while (true) {} }
});
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
    await executor.start();
    const failed = executor.execute(
      { ...ROLL_WORKER_GOLDEN_INPUT, seed: 'compatibility-budget-hang' },
      { deadlineMs: performance.now() + 50 },
    );
    const rejection = assert.rejects(failed, {
      code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
    });
    const queued = executor.execute(ROLL_WORKER_GOLDEN_INPUT, {
      deadlineMs: performance.now() + 10_000,
    });
    await rejection;
    await assertGoldenResult(await queued);
    assert.deepEqual(executor.stats(), { readyWorkers: 1, running: 0, queued: 0, restarts: 1 });
    assert.equal(reports.length, 0);
  } finally {
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
  assert.deepEqual(executor.stats(), { readyWorkers: 0, running: 0, queued: 0, restarts: 1 });
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
      message.kind === 'result' && message.result.status === 'accepted' && message.result.outcome.input.seed.startsWith('compatibility-cause-')) {
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
            await assert.rejects(
              executor.execute(
                { ...ROLL_WORKER_GOLDEN_INPUT, seed },
                { deadlineMs: performance.now() + 10_000 },
              ),
              {
                code: ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
              },
            );
          }
          assert.equal(reports.length, 2);
          await assertGoldenResult(
            await executor.execute(ROLL_WORKER_GOLDEN_INPUT, {
              deadlineMs: performance.now() + 10_000,
            }),
          );
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
