import {
  POUR_STYLE,
  type SimulationInput,
  type SimulationOutcome,
} from '@repo/dice-simulation/contract';

export const ROLL_WORKER_GOLDEN_INPUT: SimulationInput = {
  rollId: 'golden-classic-1',
  seed: 'golden-classic-1',
  rolledSlots: [0],
  pourStyle: POUR_STYLE.CLASSIC,
};

// Reviewed compatibility expectation; never derive this value from the current simulation.
export const ROLL_WORKER_GOLDEN_DIGEST =
  'sha256-q4-v2:4111ba2aff379dc6a3e8175c91cf873bba6078cf3b48fff0302d6bfe97a0404c';

export const ROLL_WORKER_GOLDEN_OUTCOME: SimulationOutcome['authoritativeValuesBySlot'] = [
  { slot: 0, value: 2 },
];
