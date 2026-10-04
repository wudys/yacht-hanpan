import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, spyOn, test } from 'bun:test';

import { DIE_GEOMETRY, TRAY_GEOMETRY } from '../contract';
import { measurePhysicsCompletion } from '../quality/physical-roll-audit';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import { hasSolverContact } from './internal/contact-query';
import { releaseRestingGroundEdges, releaseRestingWallLeans } from './internal/physics-settling';
import { topFaceAlignment } from './internal/result-recognition';
import { STEP } from './internal/roll-simulation-constants';
import { type PhysicsCompletionSnapshot, simulateRollTimeline } from './simulate-timeline';

beforeAll(initializeDeterministicRapierForBun);

test.each([
  { angle: -0.6, gap: 0.01, escape: true },
  { angle: 0.6, gap: 0.01, escape: false },
  { angle: -0.6, gap: 0.04, escape: false },
])('avoids turning a resting die toward a nearby wall ($angle, $gap)', ({ angle, gap, escape }) => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const half = DIE_GEOMETRY.size / 2;
    const support = half * (Math.cos(angle) + Math.abs(Math.sin(angle)));
    const floorTop = TRAY_GEOMETRY.floorY + TRAY_GEOMETRY.floorHalfHeight;
    const floor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(3, 0.1, 3).setTranslation(0, floorTop - 0.1, 0),
    );
    const wall = world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.1, 2, 2).setTranslation(-support - gap - 0.1, 0, 0),
    );
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, floorTop + support - 0.001, 0)
        .setRotation({ x: 0, y: 0, z: Math.sin(angle / 2), w: Math.cos(angle / 2) }),
    );
    const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(half, half, half), body);
    world.step();
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const die = { id: 'near-wall-edge', body, collider };
    const walls = [{ collider: wall, inwardX: 1, inwardZ: 0 }];
    const states = new Map();
    releaseRestingGroundEdges(world, [die], floor, 0, states, walls);
    releaseRestingGroundEdges(world, [die], floor, 100, states, walls);
    if (escape) {
      expect(body.linvel().x).toBeCloseTo(0.8, 5);
      expect(body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    } else {
      expect(body.linvel()).toEqual({ x: 0, y: 0, z: 0 });
      expect(Math.abs(body.angvel().z)).toBeGreaterThan(0.1);
    }
  } finally {
    world.free();
  }
});

test('does not use a separated predictive contact as support for a rest torque', () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    world.integrationParameters.normalizedPredictionDistance = 0.1;
    const floor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(3, 0.1, 3).setTranslation(0, -0.1, 0),
    );
    const halfSize = DIE_GEOMETRY.size / 2;
    const support = halfSize * (Math.cos(0.6) + Math.sin(0.6));
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, support + 0.04, 0)
        .setRotation({ x: 0, y: 0, z: Math.sin(0.3), w: Math.cos(0.3) }),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize),
      body,
    );
    world.step();
    expect(hasSolverContact(world, collider, floor)).toBe(true);
    expect(collider.contactCollider(floor, 0.1)!.distance).toBeGreaterThan(0.03);
    const die = { id: 'separated-die', body, collider };
    const states = new Map();
    releaseRestingGroundEdges(world, [die], floor, 0, states, []);
    releaseRestingGroundEdges(world, [die], floor, 100, states, []);
    expect(body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(body.linvel()).toEqual({ x: 0, y: 0, z: 0 });
  } finally {
    world.free();
  }
});

test.each([
  { gap: 0.04, expectedSpeed: 0 },
  { gap: 0, expectedSpeed: -0.8 },
])('only releases an actually touching wall lean (gap $gap)', ({ gap, expectedSpeed }) => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    world.integrationParameters.normalizedPredictionDistance = 0.1;
    const halfSize = DIE_GEOMETRY.size / 2;
    const support = halfSize * (Math.cos(0.6) + Math.sin(0.6));
    const floorTop = TRAY_GEOMETRY.floorY + TRAY_GEOMETRY.floorHalfHeight;
    const wall = world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.1, 2, 2).setTranslation(support + gap + 0.1, 0, 0),
    );
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, floorTop + support, 0)
        .setRotation({ x: 0, y: 0, z: Math.sin(0.3), w: Math.cos(0.3) }),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize),
      body,
    );
    world.step();
    expect(hasSolverContact(world, collider, wall)).toBe(true);
    expect(collider.contactCollider(wall, 0.1)!.distance).toBeCloseTo(gap, 4);
    // Contact generation may leave residual solver velocity; this case starts at rest.
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    releaseRestingWallLeans(
      world,
      [{ id: 'wall-lean', body, collider }],
      [{ collider: wall, inwardX: -1, inwardZ: 0 }],
      100,
      new Map(),
    );
    expect(body.linvel().x).toBeCloseTo(expectedSpeed, 5);
    expect(body.linvel().y).toBe(0);
    expect(body.linvel().z).toBe(0);
  } finally {
    world.free();
  }
});

test('does not add a ground torque in the same step as a wall escape impulse', () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    world.integrationParameters.normalizedPredictionDistance = 0.1;
    const halfSize = DIE_GEOMETRY.size / 2;
    const support = halfSize * (Math.cos(0.6) + Math.sin(0.6));
    const floorTop = TRAY_GEOMETRY.floorY + TRAY_GEOMETRY.floorHalfHeight;
    const floor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(3, 0.1, 3).setTranslation(0, floorTop - 0.1, 0),
    );
    const wall = world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.1, 2, 2).setTranslation(support + 0.1, 0, 0),
    );
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, floorTop + support, 0)
        .setRotation({ x: 0, y: 0, z: Math.sin(0.3), w: Math.cos(0.3) }),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize),
      body,
    );
    world.step();
    // Contact generation may leave residual solver velocity; this case starts at rest.
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const dice = [{ id: 'wall-and-floor-lean', body, collider }];
    const walls = [{ collider: wall, inwardX: -1, inwardZ: 0 }];
    const states = new Map();
    releaseRestingGroundEdges(world, dice, floor, 0, states, walls);
    releaseRestingWallLeans(world, dice, walls, 100, new Map());
    expect(body.linvel().x).toBeCloseTo(-0.8, 5);
    expect(body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    // No world step yet: the pose is unchanged but the body has new momentum.
    releaseRestingGroundEdges(world, dice, floor, 100, states, walls);
    expect(body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
  } finally {
    world.free();
  }
});

test('rest torque follows the current lean after movement restarts the stationary window', () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const halfSize = DIE_GEOMETRY.size / 2;
    const floorTop = TRAY_GEOMETRY.floorY + TRAY_GEOMETRY.floorHalfHeight;
    const floor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(3, 0.1, 3).setTranslation(0, floorTop - 0.1, 0),
    );
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, floorTop + halfSize * (Math.cos(0.6) + Math.sin(0.6)), 0)
        .setRotation({ x: 0, y: 0, z: Math.sin(0.3), w: Math.cos(0.3) }),
    );
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfSize, halfSize, halfSize),
      body,
    );
    const dice = [{ id: 'changing-lean', body, collider }];
    const states = new Map();
    world.step();
    releaseRestingGroundEdges(world, dice, floor, 0, states, []);

    // The die rolls past its balance point before it becomes stationary.
    // At one radian, +X is closer to upright than the previous +Y face.
    body.setRotation({ x: 0, y: 0, z: Math.sin(0.5), w: Math.cos(0.5) }, true);
    body.setTranslation({ x: 0, y: floorTop + halfSize * (Math.cos(1) + Math.sin(1)), z: 0 }, true);
    world.step();
    // Contact generation may leave residual solver velocity; this case starts at rest.
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    releaseRestingGroundEdges(world, dice, floor, 50, states, []);
    expect(body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    releaseRestingGroundEdges(world, dice, floor, 110, states, []);
    expect(body.angvel().z).toBeGreaterThan(0);
  } finally {
    world.free();
  }
});

test('classic rolls do not mostly glide flat across the tray into the opposite wall', () => {
  let flatTravel = 0;
  let wallDice = 0;
  const stepWorld = RAPIER.World.prototype.step;
  const observer = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
    this: RAPIER.World,
    ...args: Parameters<typeof stepWorld>
  ) {
    stepWorld.apply(this, args);
    let floor: RAPIER.Collider | undefined;
    this.forEachCollider((collider) => {
      if (Math.abs(collider.translation().y - TRAY_GEOMETRY.floorY) < 0.00001) floor = collider;
    });
    if (!floor) return;
    this.forEachRigidBody((body) => {
      if (!body.isDynamic() || !hasSolverContact(this, body.collider(0), floor!)) return;
      const v = body.linvel();
      const w = body.angvel();
      const speed = Math.hypot(v.x, v.z);
      if (speed > 0.5 && Math.hypot(w.x, w.y, w.z) < 1 && topFaceAlignment(body.rotation()) > 0.98)
        flatTravel += speed * this.timestep;
    });
  });
  try {
    for (let index = 0; index < 100; index += 1) {
      const seed = `slide-analysis-5-${index}`;
      const timeline = simulateRollTimeline({
        rollId: seed,
        seed,
        rolledSlots: [0, 1, 2, 3, 4],
        pourStyle: 'classic',
      });
      const side = Math.sign(timeline.cup.frames[0]!.p[0]);
      wallDice += timeline.dice.filter(
        (die) => -side * die.frames.at(-1)!.p[0] > TRAY_GEOMETRY.halfWidth - DIE_GEOMETRY.size,
      ).length;
    }
    // Diagnostic bounds: average flat, low-spin travel below one die edge,
    // with at least 60% of this fixed sample settling outside the far-wall band.
    // No trajectory or outcome is rejected by the production simulation.
    expect(flatTravel / 500).toBeLessThan(DIE_GEOMETRY.size);
    expect(wallDice / 500).toBeLessThan(0.4);
  } finally {
    observer.mockRestore();
  }
});

test.each([
  { seed: 't7-tuning-5-44', pourStyle: 'oblique' as const },
  { seed: 'coherent-pour-baseline-5-69', pourStyle: 'burst' as const },
  { seed: 'coherent-pour-holdout-a-5-106', pourStyle: 'classic' as const },
  { seed: 'mix-acceptance-20260920-127', pourStyle: 'oblique' as const },
  { seed: 'rest-final-20260920-488', pourStyle: 'oblique' as const },
  { seed: 'rest-final-20260920-200', pourStyle: 'oblique' as const },
  { seed: 'mix-holdout-20260920-497', pourStyle: 'oblique' as const },
])('settles $seed without repeatedly pushing and rotating a stopped die', ({ seed, pourStyle }) => {
  const impulse = RAPIER.RigidBody.prototype.applyImpulse;
  const torque = RAPIER.RigidBody.prototype.applyTorqueImpulse;
  const stepWorld = RAPIER.World.prototype.step;
  let elapsedSeconds = 0;
  const interventionTimes: number[] = [];
  const stepSpy = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
    this: RAPIER.World,
    ...args: Parameters<typeof stepWorld>
  ) {
    elapsedSeconds += this.timestep;
    return stepWorld.apply(this, args);
  });
  const impulseSpy = spyOn(RAPIER.RigidBody.prototype, 'applyImpulse').mockImplementation(function (
    this: RAPIER.RigidBody,
    value: RAPIER.Vector,
    wake: boolean,
  ) {
    interventionTimes.push((elapsedSeconds - STEP) * 1000);
    return impulse.call(this, value, wake);
  });
  const torqueSpy = spyOn(RAPIER.RigidBody.prototype, 'applyTorqueImpulse').mockImplementation(
    function (this: RAPIER.RigidBody, value: RAPIER.Vector, wake: boolean) {
      interventionTimes.push((elapsedSeconds - STEP) * 1000);
      return torque.call(this, value, wake);
    },
  );
  try {
    let raw: PhysicsCompletionSnapshot | undefined;
    const timeline = simulateRollTimeline(
      {
        rollId: 'low-wall-die-wedge',
        seed,
        rolledSlots: [0, 1, 2, 3, 4],
        pourStyle,
      },
      (snapshot) => {
        raw = snapshot;
      },
    );
    const report = measurePhysicsCompletion(raw!, timeline.dice);
    expect(report.rawStackedPairs).toBe(0);
    expect(report.rawLiftedDice).toBe(0);
    expect(report.rawLowReadabilityDice).toBe(0);
    expect(report.facesPreserved).toBe(true);
    // The approved interior pour assist is not a rest correction. Observe only
    // impulses after the actual complete release, not function names or totals.
    expect(
      interventionTimes.filter((t) => t > timeline.cup.releaseAtMs).length,
    ).toBeLessThanOrEqual(2);
  } finally {
    impulseSpy.mockRestore();
    torqueSpy.mockRestore();
    stepSpy.mockRestore();
  }
});

test.each([
  ['classic', 'classic', '103'],
  ['burst', 'toss', '14'],
  ['oblique', 'ricochet', '397'],
] as const)(
  'physically settles %s using historical %s seed %s without display correction',
  (pourStyle, seedStyle, id) => {
    let raw: PhysicsCompletionSnapshot | undefined;
    const timeline = simulateRollTimeline(
      {
        rollId: `quality-regression-${pourStyle}-${id}`,
        seed: `flow-audit-batch-20260918-${seedStyle}-${id}`,
        rolledSlots: [0, 1, 2, 3, 4],
        pourStyle,
      },
      (snapshot) => {
        raw = snapshot;
      },
    );

    expect(raw).toBeDefined();
    const report = measurePhysicsCompletion(raw!, timeline.dice);
    expect(report.rawStackedPairs).toBe(0);
    expect(report.rawLiftedDice).toBe(0);
    expect(report.rawLowReadabilityDice).toBe(0);
    expect(report.facesPreserved).toBe(true);
  },
);

test('leaves a two-wall corner before display correction', () => {
  let raw: PhysicsCompletionSnapshot | undefined;
  const timeline = simulateRollTimeline(
    {
      rollId: 'dice-quality-tuning-classic-3-47',
      seed: 'dice-quality-tuning-classic-3-47',
      rolledSlots: [0, 1, 2],
      pourStyle: 'classic',
    },
    (snapshot) => {
      raw = snapshot;
    },
  );
  const report = measurePhysicsCompletion(raw!, timeline.dice);
  expect(report.rawLowReadabilityDice).toBe(0);
  expect(report.rawStackedPairs).toBe(0);
  expect(report.facesPreserved).toBe(true);
});

test.each([
  {
    seed: 'b4692925d8386d75f5ccb87b39e0a4e94e78914b53c142251263c2bc00447bd0',
    slots: [0, 1, 2, 3, 4] as const,
    style: 'burst' as const,
  },
  {
    seed: 'dice-quality-tuning-toss-5-33',
    slots: [0, 1, 2, 3, 4] as const,
    style: 'burst' as const,
  },
  {
    seed: 'dice-quality-tuning-burst-4-1',
    slots: [0, 1, 2, 3] as const,
    style: 'burst' as const,
  },
  {
    seed: 'dice-quality-tuning-toss-4-19',
    slots: [0, 1, 2, 3] as const,
    style: 'burst' as const,
  },
  { seed: 'dice-quality-tuning-classic-2-18', slots: [0, 1] as const, style: 'classic' as const },
  {
    seed: 'dice-quality-tuning-classic-5-23',
    slots: [0, 1, 2, 3, 4] as const,
    style: 'classic' as const,
  },
  {
    seed: 'dice-quality-tuning-classic-5-42',
    slots: [0, 1, 2, 3, 4] as const,
    style: 'classic' as const,
  },
  {
    seed: 'dice-quality-tuning-burst-5-28',
    slots: [0, 1, 2, 3, 4] as const,
    style: 'burst' as const,
  },
])('settles a die supported by other dice: $seed', ({ seed, slots, style }) => {
  let raw: PhysicsCompletionSnapshot | undefined;
  const timeline = simulateRollTimeline(
    { rollId: seed, seed, rolledSlots: slots, pourStyle: style },
    (snapshot) => {
      raw = snapshot;
    },
  );
  const report = measurePhysicsCompletion(raw!, timeline.dice);
  expect(report.rawLiftedDice).toBe(0);
  expect(report.rawStackedPairs).toBe(0);
  expect(report.rawLowReadabilityDice).toBe(0);
  expect(report.facesPreserved).toBe(true);
});
