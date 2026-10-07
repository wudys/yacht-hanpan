import assert from 'node:assert/strict';

import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';
import { ROLL_WORKER_GOLDEN_INPUT } from '@/roll/worker/roll-worker-golden';

import { assertGoldenResult, builtWorkerUrl } from './built-roll-worker';

const ITERATIONS = 256;
const BATCH_SIZE = 8;
const MAX_RSS_GROWTH_BYTES = 256 * 1024 * 1024;

const harness = new RollSimulationWorkerPool({
  size: 1,
  maxQueued: BATCH_SIZE - 1,
  workerUrl: builtWorkerUrl,
});
await harness.start();

const rssBefore = process.memoryUsage.rss();
const startedAt = performance.now();
let completed = 0;

try {
  for (let batchStart = 0; batchStart < ITERATIONS; batchStart += BATCH_SIZE) {
    const results = await Promise.all(
      Array.from({ length: Math.min(BATCH_SIZE, ITERATIONS - batchStart) }, () =>
        harness.execute(ROLL_WORKER_GOLDEN_INPUT, { deadlineMs: performance.now() + 10_000 }),
      ),
    );
    await Promise.all(results.map(assertGoldenResult));
    completed += results.length;
  }

  const stats = harness.stats();
  const rssDeltaBytes = process.memoryUsage.rss() - rssBefore;
  const report = {
    builtWorker: builtWorkerUrl.pathname,
    bunVersion: Bun.version,
    completed,
    durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
    rssDeltaBytes,
    ...stats,
  };
  console.log(JSON.stringify(report));

  if (completed !== ITERATIONS) throw new Error(`Expected ${ITERATIONS} results, got ${completed}`);
  if (
    stats.readyWorkers !== 1 ||
    stats.running !== 0 ||
    stats.queued !== 0 ||
    stats.restarts !== 0
  ) {
    throw new Error(`Unexpected worker stats: ${JSON.stringify(stats)}`);
  }
  if (rssDeltaBytes > MAX_RSS_GROWTH_BYTES) {
    throw new Error(`RSS grew by ${rssDeltaBytes} bytes`);
  }
} finally {
  await harness.close();
}

assert.deepEqual(harness.stats(), { readyWorkers: 0, running: 0, queued: 0, restarts: 0 });
console.log(JSON.stringify({ closedWorkers: 0, queued: 0, running: 0 }));
