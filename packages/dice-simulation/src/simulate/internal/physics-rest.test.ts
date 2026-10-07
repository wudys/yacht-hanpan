import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, test } from 'bun:test';

import { initializeDeterministicRapierForBun } from '../../rapier/bun';
import { runPhysicsRest } from './physics-rest';
import { createSettlingAssistance } from './physics-settling';
import type { SettlementObservation, SettlementPolicy } from './settlement-policy';

beforeAll(initializeDeterministicRapierForBun);

function rest(observe: (tick: number, time: number) => SettlementObservation) {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  let ticks = 0;
  const policy: SettlementPolicy = {
    recordAssist() {},
    observe(_world, _dice, _floor, time, active) {
      expect(active).toBe(true);
      return observe(++ticks, time);
    },
  };
  try {
    const floor = world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.1, 1));
    const result = runPhysicsRest(
      {
        dice: [],
        simulationMs: 3000,
        policy,
        assistance: createSettlingAssistance(world, [], floor, [], policy.recordAssist),
      },
      { world, floor },
    );
    return { result, ticks };
  } finally {
    world.free();
  }
}

test('rest preserves the policy readiness but still requires ten new stable ticks', () => {
  expect(rest(() => ({ readable: true, flat: true, rejection: null }))).toEqual({
    result: { status: 'settled', simulationMs: 3167 },
    ticks: 10,
  });
});

test('a non-readable tick restarts the consecutive rest confirmation', () => {
  expect(rest((tick) => ({ readable: tick !== 9, flat: false, rejection: null }))).toEqual({
    result: { status: 'settled', simulationMs: 3317 },
    ticks: 19,
  });
});

test('the calculation limit rejects instead of returning the last visible face', () => {
  expect(rest(() => ({ readable: false, flat: false, rejection: null }))).toEqual({
    result: { status: 'rejected', reason: 'unsettled-at-limit', simulationMs: 4500 },
    ticks: 90,
  });
});

test('an early physical rejection ends computation even when readiness is also true', () => {
  expect(
    rest((_tick, simulationMs) => ({
      readable: true,
      flat: true,
      rejection: { reason: 'stable-stack', simulationMs },
    })),
  ).toEqual({
    result: { status: 'rejected', reason: 'stable-stack', simulationMs: 3017 },
    ticks: 1,
  });
});
