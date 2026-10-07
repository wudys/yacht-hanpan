import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, spyOn, test } from 'bun:test';

import type { SimulationInput } from '../contract';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import {
  evaluateRollCandidate,
  simulateRoll,
  simulateRollOutcome,
  simulateRollReplay,
  SimulationRejectedError,
} from './index';

beforeAll(initializeDeterministicRapierForBun);

// Expected times are from the independently frozen, adopted r900 experiment.
test.each([
  {
    seed: '21f806f9d20df7231635b433a1dc99aa',
    pourStyle: 'burst',
    rolledSlots: [0, 1, 2, 3],
    reason: 'stable-stack',
    simulationMs: 2567,
  },
  {
    seed: 'd71d816244d19bcfe1cc4af2be4ded05',
    pourStyle: 'oblique',
    rolledSlots: [0, 1, 2],
    reason: 'repeated-assist',
    simulationMs: 3300,
  },
] as const)('rejects $reason before producing a game outcome', async (fixture) => {
  const input: SimulationInput = {
    rollId: 'candidate-regression',
    seed: fixture.seed,
    pourStyle: fixture.pourStyle,
    rolledSlots: fixture.rolledSlots,
  };
  const free = spyOn(RAPIER.World.prototype, 'free');
  try {
    expect(await evaluateRollCandidate(input)).toEqual({
      status: 'rejected',
      input,
      reason: fixture.reason,
      simulationMs: fixture.simulationMs,
    });
    for (const simulate of [simulateRollOutcome, simulateRollReplay, simulateRoll]) {
      const result = simulate(input);
      await expect(result).rejects.toBeInstanceOf(SimulationRejectedError);
      await expect(result).rejects.toMatchObject({
        reason: fixture.reason,
        simulationMs: fixture.simulationMs,
      });
    }
    expect(free).toHaveBeenCalledTimes(4);
  } finally {
    free.mockRestore();
  }
});

test('finishes the former wall guard gap and preserves the physical result hold', async () => {
  const input: SimulationInput = {
    rollId: 'wall-guard-gap',
    seed: 'ad8a8e1d054b30cb5f30ec3ca4ed8754',
    pourStyle: 'burst',
    rolledSlots: [0, 1, 2, 3],
  };
  const candidate = await evaluateRollCandidate(input);
  const replay = await simulateRollReplay(input);
  expect(candidate).toEqual({
    status: 'accepted',
    outcome: { input, authoritativeValuesBySlot: replay.authoritativeValuesBySlot },
  });
  expect(replay.authoritativeValuesBySlot.map(({ value }) => value)).toEqual([1, 5, 4, 4]);
  for (const die of replay.timeline.dice) {
    const last = die.frames.at(-1)!;
    const physical = die.frames.at(-2)!;
    expect(physical.t).toBe(3500);
    expect(last).toEqual({ ...physical, t: 3750 });
  }
});
