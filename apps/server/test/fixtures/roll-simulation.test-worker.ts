import { appendFileSync, existsSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';

import { initializeDeterministicRapierForBun } from '@repo/dice-simulation/rapier/bun';
import { simulateRoll } from '@repo/dice-simulation/simulate';

import { ROLL_WORKER_GOLDEN_DIGEST } from '@/roll/roll-worker-golden';
import {
  type RollWorkerRequest,
  type RollWorkerResponse,
  serializeRollWorkerError,
} from '@/roll/roll-worker-protocol';

if (!parentPort) throw new Error('test roll worker requires parentPort');
const port = parentPort;

const replacementAttemptLog = process.env.ROLL_TEST_REPLACEMENT_ATTEMPT_LOG;
if (replacementAttemptLog !== undefined) {
  const isReplacement = existsSync(replacementAttemptLog);
  appendFileSync(replacementAttemptLog, 'attempt\n');
  if (isReplacement) process.exit(87);
}

if (process.env.ROLL_TEST_START_HANG === '1') {
  setInterval(() => {}, 1_000);
  await new Promise<void>(() => {});
}
if (process.env.ROLL_TEST_START_FAILURE === 'native') {
  throw new TypeError('test native startup failure', {
    cause: new RangeError('test native cause'),
  });
}
if (process.env.ROLL_TEST_START_FAILURE === 'cause') {
  const error = new TypeError('test startup failure', {
    cause: new RangeError('test startup cause'),
  });
  port.postMessage({
    kind: 'startup-error',
    error: serializeRollWorkerError(error),
  } satisfies RollWorkerResponse);
  throw error;
}

await initializeDeterministicRapierForBun();
port.postMessage({
  kind: 'ready',
  goldenDigest:
    process.env.ROLL_TEST_START_FAILURE === 'golden' ? 'invalid' : ROLL_WORKER_GOLDEN_DIGEST,
} satisfies RollWorkerResponse);

port.on('message', (request: RollWorkerRequest) => {
  if (request.kind !== 'run') return;
  if (request.input.seed === 'test-crash') process.exit(86);
  void run(request);
});

async function run(request: Extract<RollWorkerRequest, { readonly kind: 'run' }>): Promise<void> {
  try {
    if (request.input.seed === 'test-hang') return;
    if (request.input.seed === 'test-delay') await Bun.sleep(75);
    if (request.input.seed.startsWith('test-job-error-')) {
      throw new TypeError('test job failure', { cause: new RangeError('test job cause') });
    }
    if (request.input.seed === 'test-malformed') {
      port.postMessage({ kind: 'result', id: request.id, result: {} });
      return;
    }
    if (request.input.seed === 'test-wrong-id') {
      port.postMessage({
        kind: 'error',
        id: request.id + 1,
        error: serializeRollWorkerError(new Error('unmatched job response')),
      } satisfies RollWorkerResponse);
    }
    const result = await simulateRoll(request.input);
    port.postMessage({ kind: 'result', id: request.id, result } satisfies RollWorkerResponse);
  } catch (error) {
    port.postMessage({
      kind: 'error',
      id: request.id,
      error: serializeRollWorkerError(error),
    } satisfies RollWorkerResponse);
  }
}
