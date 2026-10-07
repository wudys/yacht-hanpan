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
  'sha256-q4-v2:96df9b5707861538a26f5c6313cfa55374c0df4d974aceafacd7b7cae035e3cc';

export const ROLL_WORKER_GOLDEN_OUTCOME: SimulationOutcome['authoritativeValuesBySlot'] = [
  { slot: 0, value: 3 },
  { slot: 2, value: 1 },
  { slot: 4, value: 1 },
];
