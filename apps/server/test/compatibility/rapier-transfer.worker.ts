import { parentPort } from 'node:worker_threads';

import {
  initializeDeterministicRapier,
  runDeterministicRapierDrop,
} from './deterministic-rapier-drop';
import type {
  CompatibilityWorkerRequest,
  CompatibilityWorkerResponse,
} from './rapier-transfer-protocol';

if (!parentPort) throw new Error('Compatibility worker requires a parentPort');

const port = parentPort;
const rapierVersion = await initializeDeterministicRapier();
port.postMessage({ kind: 'ready', rapierVersion } satisfies CompatibilityWorkerResponse);

port.on('message', (request: CompatibilityWorkerRequest) => {
  void handleRunRequest(request);
});

async function handleRunRequest(request: CompatibilityWorkerRequest): Promise<void> {
  try {
    const result = await runDeterministicRapierDrop(
      request.seed,
      new Float32Array(request.inputBuffer),
    );
    const response: CompatibilityWorkerResponse = {
      kind: 'result',
      id: request.id,
      signature: result.signature,
      samplesBuffer: result.samples.buffer,
    };
    port.postMessage(response, [result.samples.buffer]);
  } catch (error) {
    port.postMessage({
      kind: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : 'Unknown worker failure',
    } satisfies CompatibilityWorkerResponse);
  }
}
