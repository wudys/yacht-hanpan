import { Worker } from 'node:worker_threads';

import type {
  CompatibilityWorkerResponse,
  RapierDropResult,
  WorkerRunRequest,
} from './rapier-transfer-protocol';

// One-shot primitive transfer probe. Pool capacity and replacement belong to the production executor.
export async function runRapierTransferProbe(
  seed: string,
  input: Float32Array<ArrayBuffer>,
): Promise<RapierDropResult> {
  const worker = new Worker(new URL('./rapier-transfer.worker.ts', import.meta.url));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<RapierDropResult>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Compatibility transfer probe timed out')),
        2_000,
      );
      worker.on('error', reject);
      worker.on('exit', (code) => reject(new Error(`Compatibility worker exited with ${code}`)));
      worker.on('message', (response: CompatibilityWorkerResponse) => {
        if (response.kind === 'ready') {
          const request: WorkerRunRequest = { kind: 'run', id: 1, seed, inputBuffer: input.buffer };
          worker.postMessage(request, [request.inputBuffer]);
        } else if (response.kind === 'error') {
          reject(new Error(response.message));
        } else {
          resolve({
            signature: response.signature,
            samples: new Float32Array(response.samplesBuffer),
          });
        }
      });
    });
  } finally {
    clearTimeout(timeout);
    await worker.terminate();
  }
}
