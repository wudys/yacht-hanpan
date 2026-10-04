import { parentPort } from 'node:worker_threads';

import { initializeDeterministicRapierForBun } from '@repo/dice-simulation/rapier/bun';
import { simulateRoll, simulateRollOutcome } from '@repo/dice-simulation/simulate';

import {
  ROLL_WORKER_GOLDEN_DIGEST,
  ROLL_WORKER_GOLDEN_INPUT,
  ROLL_WORKER_GOLDEN_OUTCOME,
} from '@/roll/roll-worker-golden';
import {
  type RollWorkerRequest,
  type RollWorkerResponse,
  serializeRollWorkerError,
} from '@/roll/roll-worker-protocol';

if (!parentPort) throw new Error('roll simulation worker requires parentPort');
const port = parentPort;

try {
  await initializeDeterministicRapierForBun();
  const golden = await simulateRoll(ROLL_WORKER_GOLDEN_INPUT);
  if (golden.replayDigest !== ROLL_WORKER_GOLDEN_DIGEST) {
    throw new Error('roll simulation worker golden mismatch');
  }
  const outcome = await simulateRollOutcome(ROLL_WORKER_GOLDEN_INPUT);
  if (
    outcome.authoritativeValuesBySlot.length !== ROLL_WORKER_GOLDEN_OUTCOME.length ||
    outcome.authoritativeValuesBySlot.some(
      (face, index) =>
        face.slot !== ROLL_WORKER_GOLDEN_OUTCOME[index]?.slot ||
        face.value !== ROLL_WORKER_GOLDEN_OUTCOME[index]?.value,
    )
  ) {
    throw new Error('roll simulation worker outcome golden mismatch');
  }
  port.postMessage({
    kind: 'ready',
    goldenDigest: golden.replayDigest,
  } satisfies RollWorkerResponse);
} catch (error) {
  port.postMessage({
    kind: 'startup-error',
    error: serializeRollWorkerError(error),
  } satisfies RollWorkerResponse);
  throw error;
}

port.on('message', (request: RollWorkerRequest) => {
  if (request.kind === 'run') void execute(request);
});

async function execute(request: RollWorkerRequest): Promise<void> {
  try {
    const result = await simulateRollOutcome(request.input);
    port.postMessage({ kind: 'result', id: request.id, result } satisfies RollWorkerResponse);
  } catch (error) {
    port.postMessage({
      kind: 'error',
      id: request.id,
      error: serializeRollWorkerError(error),
    } satisfies RollWorkerResponse);
  }
}
