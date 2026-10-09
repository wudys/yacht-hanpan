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
  'sha256-q4-v2:9415f0ddfe44a023309e42202a9bbba9296c4122218695514fbf6e1227542040';

export const ROLL_WORKER_GOLDEN_OUTCOME: SimulationOutcome['authoritativeValuesBySlot'] = [
  { slot: 0, value: 3 },
  { slot: 2, value: 4 },
  { slot: 4, value: 6 },
];
