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

// Reviewed real-engine inputs preserve both physical rejection reasons.
test.each([
  {
    seed: '57b63a0ec375ad0c46eff21eddb2495f034b6e58b0762d581c76f438edbaaeaf',
    pourStyle: 'burst',
    rolledSlots: [0, 1, 2, 3, 4],
    reason: 'stable-stack',
    simulationMs: 2617,
  },
  {
    seed: 'bd8b8c3e8b3871db1c966a62fd23d5d62ccfd105d5d3cf0e17fb6572828ca392',
    pourStyle: 'burst',
    rolledSlots: [0, 1, 2, 3],
    reason: 'repeated-assist',
    simulationMs: 3250,
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
  expect(replay.authoritativeValuesBySlot.map(({ value }) => value)).toEqual([3, 1, 3, 3]);
  for (const die of replay.timeline.dice) {
    const last = die.frames.at(-1)!;
    const physical = die.frames.at(-2)!;
    expect(physical.t).toBe(3467);
    expect(last).toEqual({ ...physical, t: 3717 });
  }
});
