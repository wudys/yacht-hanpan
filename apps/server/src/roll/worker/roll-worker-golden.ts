import {
  POUR_STYLE,
  type SimulationInput,
  type SimulationOutcome,
} from '@repo/dice-simulation/contract';

export const ROLL_WORKER_GOLDEN_INPUT: SimulationInput = {
  rollId: 'golden-oblique-3',
  seed: 'golden-oblique-3',
  rolledSlots: [0, 2, 4],
  pourStyle: POUR_STYLE.OBLIQUE,
};

// Reviewed compatibility expectation; never derive this value from the current simulation.
export const ROLL_WORKER_GOLDEN_DIGEST =
  'sha256-q4-v2:945ba495ebf1be382fc082afe239dd5cdd75dcce8eea07d7eb1f30c1a2803f73';

export const ROLL_WORKER_GOLDEN_OUTCOME: SimulationOutcome['authoritativeValuesBySlot'] = [
  { slot: 0, value: 4 },
  { slot: 2, value: 6 },
  { slot: 4, value: 6 },
];
