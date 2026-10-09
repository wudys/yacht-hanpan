import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, spyOn, test } from 'bun:test';

import type { SimulationInput } from '../contract';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import {
  evaluateRollCandidate,
  simulateRollOutcome,
  simulateRollReplay,
  simulateRollWithDigest,
  SimulationRejectedError,
} from './index';

beforeAll(initializeDeterministicRapierForBun);

// Reviewed v37 real-engine inputs preserve both rejection reasons after the layout change.
test.each([
  {
    seed: 'rejection-regression-v37-burst-5-3008',
    pourStyle: 'burst',
    rolledSlots: [0, 1, 2, 3, 4],
    reason: 'stable-stack',
    simulationMs: 2717,
  },
  {
    seed: 'rejection-regression-v37-burst-4-281',
    pourStyle: 'burst',
    rolledSlots: [0, 1, 2, 3],
    reason: 'repeated-assist',
    simulationMs: 3350,
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
    for (const simulate of [simulateRollOutcome, simulateRollReplay, simulateRollWithDigest]) {
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
  expect(replay.authoritativeValuesBySlot.map(({ value }) => value)).toEqual([2, 1, 5, 2]);
  for (const die of replay.timeline.dice) {
    const last = die.frames.at(-1)!;
    const physical = die.frames.at(-2)!;
    expect(physical.t).toBe(3167);
    expect(last).toEqual({ ...physical, t: 3417 });
  }
});
