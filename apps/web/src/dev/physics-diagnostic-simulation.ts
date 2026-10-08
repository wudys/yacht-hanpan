import { parseSimulationInput, type SimulationResult } from '@repo/dice-simulation/contract';
import {
  DETERMINISTIC_RAPIER_WASM_FILE,
  initializeDeterministicRapierForBrowser,
} from '@repo/dice-simulation/rapier/browser';
import { simulateRollWithDigest } from '@repo/dice-simulation/simulate';

export type PhysicsDiagnosticInput = Readonly<{ seed: string; pourStyle: string; count: number }>;

// Cancellation excludes stale results; it cannot interrupt synchronous physics work.
export async function runPhysicsDiagnostic(
  input: PhysicsDiagnosticInput,
  signal?: AbortSignal,
): Promise<SimulationResult> {
  signal?.throwIfAborted();
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > 5) {
    throw new Error('Count must be an integer from 1 to 5');
  }
  const recipe = parseSimulationInput({
    rollId: 'quality-visual-fixture',
    seed: input.seed,
    pourStyle: input.pourStyle,
    rolledSlots: [0, 1, 2, 3, 4].slice(0, input.count),
  });
  await initializeDeterministicRapierForBrowser(
    `/runtime/${DETERMINISTIC_RAPIER_WASM_FILE}`,
    signal,
  );
  signal?.throwIfAborted();
  const result = await simulateRollWithDigest(recipe);
  signal?.throwIfAborted();
  return result;
}
