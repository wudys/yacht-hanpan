import { POUR_STYLE, type SimulationInput } from '@repo/dice-simulation/contract';

export const ROLL_WORKER_GOLDEN_INPUT: SimulationInput = {
  rollId: 'golden-classic-1',
  seed: 'golden-classic-1',
  rolledSlots: [0],
  pourStyle: POUR_STYLE.CLASSIC,
};

// Reviewed compatibility expectation; never derive this value from the current simulation.
export const ROLL_WORKER_GOLDEN_DIGEST =
  'sha256-q4-v2:4102ce173bcedd8bbe65156a861ffabede591c275617d26136a0a79e2c754658';
