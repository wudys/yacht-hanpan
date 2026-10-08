import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, spyOn, test } from 'bun:test';

import { initializeDeterministicRapierForBun } from '../../../rapier/bun';
import { hasActualLowerSupportContact } from '../contact-query';
import type { PhysicsDie } from '../physics-environment';
import { DIE_SIZE, FLOOR_TOP_Y } from '../roll-simulation-constants';
import { createSettlementPolicy } from './settlement-policy';

beforeAll(initializeDeterministicRapierForBun);

function fixture(positions: readonly { x: number; y: number; angle?: number }[]) {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const floor = world.createCollider(
    RAPIER.ColliderDesc.cuboid(4, 0.1, 4).setTranslation(0, FLOOR_TOP_Y - 0.1, 0),
  );
  const dice = positions.map(({ x, y, angle = 0 }, index): PhysicsDie => {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y, 0)
        .setRotation({ x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) }),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(DIE_SIZE / 2, DIE_SIZE / 2, DIE_SIZE / 2),
      body,
    );
    return { id: `die-${index}`, body, collider };
  });
  const refresh = () => {
    world.step();
    dice.forEach(({ body }) => {
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    });
  };
  refresh();
  return { world, floor, dice, refresh };
}

const floorY = FLOOR_TOP_Y + DIE_SIZE / 2 - 0.001;
const tiltedY = FLOOR_TOP_Y + (DIE_SIZE / 2) * Math.SQRT2 - 0.001;

test('readable stability requires actual floor support and a global 150ms pose anchor', () => {
  const { world, floor, dice, refresh } = fixture([
    { x: -1, y: floorY },
    { x: 1, y: floorY },
  ]);
  try {
    const policy = createSettlementPolicy();
    expect(hasActualLowerSupportContact(world, dice[0].collider, floor)).toBe(true);
    expect(policy.observe(world, dice, floor, 0, false).readable).toBe(false);
    expect(policy.observe(world, dice, floor, 10, true).readable).toBe(false);
    expect(policy.observe(world, dice, floor, 159, true).readable).toBe(false);
    expect(policy.observe(world, dice, floor, 160, true)).toEqual({
      readable: true,
      flat: true,
      rejection: null,
    });
    dice[1].body.setTranslation({ x: 1.005, y: floorY, z: 0 }, true);
    refresh();
    expect(policy.observe(world, dice, floor, 170, true).readable).toBe(false);
    expect(policy.observe(world, dice, floor, 319, true).readable).toBe(false);
    expect(policy.observe(world, dice, floor, 320, true).readable).toBe(true);
    // Each roll owns a new policy even when it observes the same bodies.
    expect(createSettlementPolicy().observe(world, dice, floor, 320, true).readable).toBe(false);
  } finally {
    world.free();
  }
});

test('a separated predictive floor contact cannot start readable stability', () => {
  const { world, floor, dice } = fixture([{ x: 0, y: floorY + 0.04 }]);
  try {
    world.integrationParameters.normalizedPredictionDistance = 0.1;
    world.step();
    expect(dice[0].collider.contactCollider(floor, 0.1)!.distance).toBeGreaterThan(0.03);
    const policy = createSettlementPolicy();
    policy.observe(world, dice, floor, 0, true);
    expect(policy.observe(world, dice, floor, 1000, true).readable).toBe(false);
  } finally {
    world.free();
  }
});

test('stable stack rejection waits for all support participant poses and restarts when a lower die moves', () => {
  const { world, floor, dice, refresh } = fixture([
    { x: 0, y: floorY },
    { x: 0, y: floorY + DIE_SIZE - 0.001 },
  ]);
  try {
    expect(hasActualLowerSupportContact(world, dice[1].collider, dice[0].collider)).toBe(true);
    const policy = createSettlementPolicy();
    policy.observe(world, dice, floor, 0, true);
    expect(policy.observe(world, dice, floor, 199, true).rejection).toBeNull();
    dice[0].body.setTranslation({ x: 0.006, y: floorY, z: 0 }, true);
    refresh();
    expect(policy.observe(world, dice, floor, 200, true).rejection).toBeNull();
    expect(policy.observe(world, dice, floor, 399, true).rejection).toBeNull();
    expect(policy.observe(world, dice, floor, 400, true).rejection).toEqual({
      reason: 'stable-stack',
      simulationMs: 400,
    });
  } finally {
    world.free();
  }
});

test('moving support and inactive cup phases cannot count towards stable stack rejection', () => {
  const { world, floor, dice } = fixture([
    { x: 0, y: floorY },
    { x: 0, y: floorY + DIE_SIZE - 0.001 },
  ]);
  try {
    const policy = createSettlementPolicy();
    policy.observe(world, dice, floor, 0, false);
    dice[0].body.setAngvel({ x: 0, y: 0, z: 0.61 }, true);
    expect(policy.observe(world, dice, floor, 300, true).rejection).toBeNull();
    dice[0].body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    policy.observe(world, dice, floor, 400, true);
    expect(policy.observe(world, dice, floor, 599, true).rejection).toBeNull();
    expect(policy.observe(world, dice, floor, 600, true).rejection?.reason).toBe('stable-stack');
  } finally {
    world.free();
  }
});

test('stable stack rejection requires every support branch to reach the floor', () => {
  const {
    world,
    floor: initialFloor,
    dice,
    refresh,
  } = fixture([
    { x: -0.6 * DIE_SIZE, y: floorY },
    { x: 0.6 * DIE_SIZE, y: floorY },
    { x: 0, y: floorY + DIE_SIZE - 0.001 },
  ]);
  try {
    world.removeCollider(initialFloor, false);
    const floor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(DIE_SIZE / 2, 0.1, 4).setTranslation(
        -0.6 * DIE_SIZE,
        FLOOR_TOP_Y - 0.1,
        0,
      ),
    );
    refresh();
    refresh();
    expect(hasActualLowerSupportContact(world, dice[0].collider, floor)).toBe(true);
    expect(hasActualLowerSupportContact(world, dice[1].collider, floor)).toBe(false);
    expect(hasActualLowerSupportContact(world, dice[2].collider, dice[0].collider)).toBe(true);
    expect(hasActualLowerSupportContact(world, dice[2].collider, dice[1].collider)).toBe(true);
    const policy = createSettlementPolicy();
    policy.observe(world, dice, floor, 0, true);
    expect(policy.observe(world, dice, floor, 1000, true).rejection).toBeNull();
    const fullFloor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(4, 0.1, 4).setTranslation(0, FLOOR_TOP_Y - 0.1, 0),
    );
    refresh();
    refresh();
    policy.observe(world, dice, fullFloor, 1100, true);
    expect(policy.observe(world, dice, fullFloor, 1299, true).rejection).toBeNull();
    expect(policy.observe(world, dice, fullFloor, 1300, true).rejection?.reason).toBe(
      'stable-stack',
    );
  } finally {
    world.free();
  }
});

test('flat readiness requires its stricter speeds and cannot bypass the global readable stability anchor', () => {
  const { world, floor, dice } = fixture([{ x: 0, y: floorY }]);
  try {
    const policy = createSettlementPolicy();
    dice[0].body.setLinvel({ x: 0.04, y: 0, z: 0 }, true);
    policy.observe(world, dice, floor, 0, true);
    expect(policy.observe(world, dice, floor, 150, true)).toEqual({
      readable: true,
      flat: false,
      rejection: null,
    });
    dice[0].body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    expect(policy.observe(world, dice, floor, 200, true).flat).toBe(false);
    expect(policy.observe(world, dice, floor, 350, true).flat).toBe(true);
    dice[0].body.setAngvel({ x: 0.19, y: 0, z: 0 }, true);
    expect(policy.observe(world, dice, floor, 400, true).readable).toBe(false);
    dice[0].body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    expect(policy.observe(world, dice, floor, 500, true).flat).toBe(false);
    expect(policy.observe(world, dice, floor, 650, true).flat).toBe(true);
  } finally {
    world.free();
  }
});

test('repeated assistance counts only actual deltas, waits900ms, and survives brief separation', () => {
  const { world, floor, dice, refresh } = fixture([{ x: 0, y: tiltedY, angle: Math.PI / 4 }]);
  try {
    const policy = createSettlementPolicy();
    const record = (simulationMs: number, actualDelta: number) =>
      policy.recordAssist({ dieId: dice[0].id, simulationMs, kind: 'side', actualDelta });
    record(0, 0.1);
    record(300, 0.1);
    record(600, 0);
    expect(policy.observe(world, dice, floor, 900, true).rejection).toBeNull();
    record(950, 0.1);
    dice[0].body.setTranslation({ x: 0, y: tiltedY + 0.1, z: 0 }, true);
    refresh();
    expect(policy.observe(world, dice, floor, 950, true).rejection).toBeNull();
    dice[0].body.setTranslation({ x: 0, y: tiltedY, z: 0 }, true);
    refresh();
    refresh();
    expect(hasActualLowerSupportContact(world, dice[0].collider, floor)).toBe(true);
    expect(policy.observe(world, dice, floor, 1000, true).rejection).toEqual({
      reason: 'repeated-assist',
      simulationMs: 1000,
    });
  } finally {
    world.free();
  }
});

test('only that die’s150ms readable recovery clears its unresolved assist episode', () => {
  const { world, floor, dice, refresh } = fixture([{ x: 0, y: tiltedY, angle: Math.PI / 4 }]);
  try {
    const policy = createSettlementPolicy();
    for (const simulationMs of [0, 300, 600])
      policy.recordAssist({ dieId: dice[0].id, simulationMs, kind: 'torque', actualDelta: 0.1 });
    dice[0].body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    dice[0].body.setTranslation({ x: 0, y: floorY, z: 0 }, true);
    refresh();
    policy.observe(world, dice, floor, 700, true);
    policy.observe(world, dice, floor, 850, true);
    dice[0].body.setRotation(
      { x: 0, y: 0, z: Math.sin(Math.PI / 8), w: Math.cos(Math.PI / 8) },
      true,
    );
    dice[0].body.setTranslation({ x: 0, y: tiltedY, z: 0 }, true);
    refresh();
    expect(policy.observe(world, dice, floor, 1000, true).rejection).toBeNull();
    for (const simulationMs of [1100, 1400, 1700])
      policy.recordAssist({ dieId: dice[0].id, simulationMs, kind: 'wall', actualDelta: 0.1 });
    expect(policy.observe(world, dice, floor, 1999, true).rejection).toBeNull();
    expect(policy.observe(world, dice, floor, 2000, true).rejection?.reason).toBe(
      'repeated-assist',
    );
  } finally {
    world.free();
  }
});

test('same-neighbour recontact and replacing that neighbour retain assistance age', () => {
  const sideX = (DIE_SIZE / 2) * (Math.SQRT2 + 1) - 0.001;
  const floatingY = FLOOR_TOP_Y + 2 * DIE_SIZE;
  const { world, floor, dice, refresh } = fixture([
    { x: 0, y: floatingY, angle: Math.PI / 4 },
    { x: sideX, y: floatingY },
    { x: -sideX - 1, y: floatingY },
  ]);
  try {
    const policy = createSettlementPolicy();
    for (const simulationMs of [0, 300, 600])
      policy.recordAssist({ dieId: dice[0].id, simulationMs, kind: 'side', actualDelta: 0.1 });
    expect(dice[0].collider.contactCollider(dice[1].collider, 0.005)).not.toBeNull();
    expect(policy.observe(world, dice, floor, 899, true).rejection).toBeNull();
    dice[1].body.setTranslation({ x: sideX + 1, y: floatingY, z: 0 }, true);
    refresh();
    expect(policy.observe(world, dice, floor, 900, true).rejection).toBeNull();
    dice[1].body.setTranslation({ x: sideX, y: floatingY, z: 0 }, true);
    refresh();
    expect(policy.observe(world, dice, floor, 950, true).rejection?.reason).toBe('repeated-assist');
    dice[1].body.setTranslation({ x: sideX + 1, y: floatingY, z: 0 }, true);
    dice[2].body.setTranslation({ x: -sideX, y: floatingY, z: 0 }, true);
    refresh();
    expect(dice[0].collider.contactCollider(dice[2].collider, 0.005)).not.toBeNull();
    expect(policy.observe(world, dice, floor, 1000, true).rejection?.reason).toBe(
      'repeated-assist',
    );
  } finally {
    world.free();
  }
});

test('one die recovering cannot erase another die’s unresolved episode', () => {
  const { world, floor, dice, refresh } = fixture([
    { x: -1, y: tiltedY, angle: Math.PI / 4 },
    { x: 1, y: tiltedY, angle: Math.PI / 4 },
  ]);
  try {
    const policy = createSettlementPolicy();
    for (const die of dice)
      for (const simulationMs of [0, 300, 600])
        policy.recordAssist({ dieId: die.id, simulationMs, kind: 'side', actualDelta: 0.1 });
    dice[0].body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    dice[0].body.setTranslation({ x: -1, y: floorY, z: 0 }, true);
    refresh();
    policy.observe(world, dice, floor, 700, true);
    policy.observe(world, dice, floor, 850, true);
    expect(policy.observe(world, dice, floor, 900, true).rejection?.reason).toBe('repeated-assist');
  } finally {
    world.free();
  }
});

test('stable stack rejection takes priority when it and repeated assistance reach their thresholds together', () => {
  const { world, floor, dice } = fixture([
    { x: 0, y: floorY },
    {
      x: 0,
      y: floorY + (DIE_SIZE / 2) * (1 + Math.SQRT2) - 0.001,
      angle: Math.PI / 4,
    },
  ]);
  try {
    const policy = createSettlementPolicy();
    expect(hasActualLowerSupportContact(world, dice[1].collider, dice[0].collider)).toBe(true);
    for (const simulationMs of [0, 300, 600])
      policy.recordAssist({ dieId: dice[1].id, simulationMs, kind: 'torque', actualDelta: 0.1 });
    policy.observe(world, dice, floor, 700, true);
    expect(policy.observe(world, dice, floor, 899, true).rejection).toBeNull();
    expect(policy.observe(world, dice, floor, 900, true).rejection).toEqual({
      reason: 'stable-stack',
      simulationMs: 900,
    });
  } finally {
    world.free();
  }
});

// Exact observation bounds are tested before Float32 body velocity storage rounds them.
test.each([
  { linear: 0.045 - 1e-8, angular: 0.18 - 1e-8, readable: true },
  { linear: 0.045, angular: 0, readable: false },
  { linear: 0, angular: 0.18, readable: false },
])('reading keeps strict speed bounds ($linear, $angular)', ({ linear, angular, readable }) => {
  const { world, floor, dice } = fixture([{ x: 0, y: floorY }]);
  const linearSpy = spyOn(dice[0].body, 'linvel').mockReturnValue({ x: linear, y: 0, z: 0 });
  const angularSpy = spyOn(dice[0].body, 'angvel').mockReturnValue({ x: angular, y: 0, z: 0 });
  try {
    const policy = createSettlementPolicy();
    policy.observe(world, dice, floor, 0, true);
    expect(policy.observe(world, dice, floor, 150, true).readable).toBe(readable);
  } finally {
    linearSpy.mockRestore();
    angularSpy.mockRestore();
    world.free();
  }
});

test.each([
  { linear: 0.2 - 1e-8, angular: 0.6 - 1e-8, rejected: true },
  { linear: 0.2, angular: 0, rejected: false },
  { linear: 0, angular: 0.6, rejected: false },
])(
  'repeated assistance keeps strict slow bounds ($linear, $angular)',
  ({ linear, angular, rejected }) => {
    const { world, floor, dice } = fixture([{ x: 0, y: tiltedY, angle: Math.PI / 4 }]);
    const linearSpy = spyOn(dice[0].body, 'linvel').mockReturnValue({ x: linear, y: 0, z: 0 });
    const angularSpy = spyOn(dice[0].body, 'angvel').mockReturnValue({ x: angular, y: 0, z: 0 });
    try {
      const policy = createSettlementPolicy();
      for (const simulationMs of [0, 300, 600])
        policy.recordAssist({ dieId: dice[0].id, simulationMs, kind: 'torque', actualDelta: 1 });
      expect(policy.observe(world, dice, floor, 900, true).rejection !== null).toBe(rejected);
    } finally {
      linearSpy.mockRestore();
      angularSpy.mockRestore();
      world.free();
    }
  },
);
