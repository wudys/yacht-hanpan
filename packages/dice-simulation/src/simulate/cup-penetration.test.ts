import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, spyOn, test } from 'bun:test';

import { type DieSlot, POUR_STYLES } from '../contract';
import { DEFAULT_CUP_GEOMETRY as CUP } from '../contract/cup-geometry';
import { DIE_GEOMETRY } from '../contract/roll-geometry';
import { measureCupBottomBoundary } from '../quality/cup-boundary-audit';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import { createCupMotion } from './internal/cup/cup-motion';
import { createPhysicsCup, haveDiceClearedCup } from './internal/cup/physics-cup';
import { createRollPhysicsConfig } from './internal/physics-config';
import { createDieInCup } from './internal/physics-environment';
import { FLOOR_Y } from './internal/roll-simulation-constants';
import { quatFromEuler, rotateVectorByQuat } from './internal/simulation-math';
import { simulateRollTimeline } from './simulate-physics';

beforeAll(initializeDeterministicRapierForBun);

const geometryCases = [
  { name: 'separated above the base', x: 0, y: 0, tilt: 0, minimum: 0, maximum: 0 },
  {
    name: 'touching the base',
    x: 0,
    y: -CUP.innerHeight / 2 + DIE_GEOMETRY.size / 2,
    tilt: 0,
    minimum: 0,
    maximum: 0.00001,
  },
  {
    name: 'small overlap',
    x: 0,
    y: -CUP.innerHeight / 2 + DIE_GEOMETRY.size / 2 - 0.01,
    tilt: 0,
    minimum: 0.009,
    maximum: 0.011,
  },
  {
    name: 'outside the finite base',
    x: CUP.bottomRadius + CUP.wallThickness + DIE_GEOMETRY.size,
    y: -CUP.innerHeight / 2,
    tilt: 0,
    minimum: 0,
    maximum: 0,
  },
  {
    name: 'rotated overlap beyond the radial support point',
    x: 1.1,
    y: -0.8,
    tilt: Math.PI / 3,
    minimum: CUP.baseThickness / 2,
    maximum: Infinity,
  },
];

test.each(geometryCases)(
  'measures finite base depth for $name in shared rigid poses',
  (fixture) => {
    const depths: number[] = [];
    for (const pose of [
      { x: 0, y: 0, z: 0, yaw: 0, tilt: 0 },
      { x: 2, y: 3, z: -4, yaw: 0, tilt: Math.PI / 6 },
    ]) {
      const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
      try {
        const cup = createPhysicsCup(world, pose, CUP);
        // createPhysicsCup adds the finite base first, followed by the wall segments.
        const base = cup.body.collider(0);
        expect(base.shapeType()).toBe(RAPIER.ShapeType.Cylinder);
        expect(base.radius()).toBeCloseTo(CUP.bottomRadius + CUP.wallThickness, 6);
        expect(base.halfHeight()).toBeCloseTo(CUP.baseThickness / 2, 6);
        const die = createDieInCup(
          world,
          'finite-base-witness',
          0,
          1,
          createCupMotion('finite-base-witness', 'classic'),
          createRollPhysicsConfig(),
        );
        expect(die.collider.shapeType()).toBe(RAPIER.ShapeType.RoundCuboid);
        const offset = rotateVectorByQuat([fixture.x, fixture.y, 0], cup.body.rotation());
        die.body.setTranslation(
          { x: pose.x + offset[0], y: pose.y + offset[1], z: pose.z + offset[2] },
          false,
        );
        die.body.setRotation(quatFromEuler(0, 0, pose.tilt + fixture.tilt), false);
        world.propagateModifiedBodyPositionsToColliders();
        const depth = basePenetration(die.body, cup.body);
        if (fixture.minimum > 0) expect(depth).toBeGreaterThan(fixture.minimum);
        else expect(depth).toBeGreaterThanOrEqual(0);
        expect(depth).toBeLessThanOrEqual(fixture.maximum);
        depths.push(depth);
      } finally {
        world.free();
      }
    }
    expect(depths[1]).toBeCloseTo(depths[0]!, 5);
  },
);

const cases = POUR_STYLES.flatMap((pourStyle) =>
  [1, 2, 3, 4, 5].flatMap((count) =>
    Array.from({ length: 12 }, (_, index) => ({
      seed: `cup-bottom-probe-${index}`,
      pourStyle,
      count,
    })),
  ),
);

test('bottom boundary queries leave recorded physics unchanged', () => {
  const input = {
    rollId: 'cup-bottom-observer-parity',
    seed: 'cup-bottom-probe-0',
    pourStyle: 'classic' as const,
    rolledSlots: [0, 1, 2, 3, 4] as DieSlot[],
  };
  const baseline = simulateRollTimeline(input);
  const stepWorld = RAPIER.World.prototype.step;
  let queries = 0;
  const observer = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
    this: RAPIER.World,
    ...args: Parameters<typeof stepWorld>
  ) {
    stepWorld.apply(this, args);
    const bodies: RAPIER.RigidBody[] = [];
    this.forEachRigidBody((body) => bodies.push(body));
    const cup = bodies.find((body) => body.isKinematic());
    if (!cup) return;
    for (const die of bodies.filter((body) => body.isDynamic())) {
      measureCupBottomBoundary(die.collider(0), cup.collider(0));
      queries += 1;
    }
  });
  try {
    expect(simulateRollTimeline(input)).toEqual(baseline);
    expect(queries).toBeGreaterThan(0);
  } finally {
    observer.mockRestore();
  }
});

test.each([
  { gap: -0.001, sensor: false, touching: true },
  { gap: 0.04, sensor: false, touching: false },
  { gap: -0.001, sensor: true, touching: false },
])('distinguishes actual solver contact from prediction and sensors ($gap, $sensor)', (fixture) => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    world.integrationParameters.normalizedPredictionDistance = 0.1;
    const floor = world.createCollider(
      RAPIER.ColliderDesc.cuboid(3, 0.1, 3).setTranslation(0, -0.1, 0),
    );
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 0.3 + fixture.gap, 0),
    );
    const die = world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.3, 0.3, 0.3).setSensor(fixture.sensor),
      body,
    );
    world.step();
    if (!fixture.sensor) {
      let solverContacts = 0;
      world.contactPair(die, floor, (manifold) => {
        solverContacts += manifold.numSolverContacts();
      });
      expect(solverContacts).toBeGreaterThan(0);
    }
    expect(hasActualSolverContact(world, die, floor)).toBe(fixture.touching);
  } finally {
    world.free();
  }
});

test.each(cases)(
  'keeps $seed ($pourStyle, $count dice) inside the base until mouth exit without floor pinch',
  ({ seed, pourStyle, count }) => {
    const stepWorld = RAPIER.World.prototype.step;
    const exited = new Set<number>();
    const penetrations: {
      timeMs: number;
      die: number;
      depth: number;
      axisMinimumOuterGap: number;
      externalOverlapDepth: number;
      exited: boolean;
    }[] = [];
    const pinches: { timeMs: number; die: number; exited: boolean }[] = [];
    let elapsedSeconds = 0;
    let observedFloor = false;
    let observedSteps = 0;
    const observer = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
      this: RAPIER.World,
      ...args: Parameters<typeof stepWorld>
    ) {
      stepWorld.apply(this, args);
      elapsedSeconds += this.timestep;
      const bodies: RAPIER.RigidBody[] = [];
      this.forEachRigidBody((body) => bodies.push(body));
      const cupBody = bodies.find((body) => body.isKinematic());
      if (!cupBody) return;
      observedSteps += 1;
      const floor = bodies
        .filter((body) => body.isFixed())
        .flatMap((body) => Array.from({ length: body.numColliders() }, (_, i) => body.collider(i)))
        .find((collider) => Math.abs(collider.translation().y - FLOOR_Y) < 0.00001);
      if (!floor) throw new Error('Production tray floor was not found');
      observedFloor = true;
      const timeMs = elapsedSeconds * 1000;
      const cup = {
        geometry: CUP,
        body: cupBody,
        colliders: Array.from({ length: cupBody.numColliders() }, (_, i) => cupBody.collider(i)),
      };
      for (const body of bodies.filter((body) => body.isDynamic())) {
        const die = { body, collider: body.collider(0), id: String(body.handle) };
        if (haveDiceClearedCup(cup, [die])) exited.add(body.handle);
        // Observe floor pinch even after mouth exit, while the remaining dice leave.
        if (
          hasActualSolverContact(this, die.collider, floor) &&
          cup.colliders.some((collider) => hasActualSolverContact(this, die.collider, collider))
        ) {
          pinches.push({ timeMs, die: body.handle, exited: exited.has(body.handle) });
        }
        // Released dice can legitimately bounce below the finite cup.
        if (exited.has(body.handle)) continue;
        const boundary = measureCupBottomBoundary(die.collider, cup.colliders[0]);
        if (boundary.externalBottomCrossing)
          penetrations.push({
            timeMs,
            die: body.handle,
            depth: boundary.baseContactDepth,
            axisMinimumOuterGap: boundary.axisMinimumOuterGap,
            externalOverlapDepth: boundary.externalOverlapDepth,
            exited: false,
          });
      }
    });
    try {
      simulateRollTimeline({
        rollId: seed,
        seed,
        pourStyle,
        rolledSlots: Array.from({ length: count }, (_, i) => i as DieSlot),
      });
      expect(observedSteps).toBeGreaterThan(0);
      expect(observedFloor).toBe(true);
      expect(exited.size).toBe(count);
      // Internal contact overlap can be hidden inside the thickness; the external
      // finite cylinder query must remain clear until this die crosses the mouth.
      expect({ seed, pourStyle, count, penetrations }).toEqual({
        seed,
        pourStyle,
        count,
        penetrations: [],
      });
      expect({ seed, pourStyle, count, pinches }).toEqual({ seed, pourStyle, count, pinches: [] });
    } finally {
      observer.mockRestore();
    }
  },
);

function basePenetration(die: RAPIER.RigidBody, cup: RAPIER.RigidBody): number {
  // Unlike an infinite plane or one support point, this measures both finite shapes.
  const contact = die.collider(0).contactCollider(cup.collider(0), 0);
  return contact ? Math.max(0, -contact.distance) : 0;
}

function hasActualSolverContact(
  world: RAPIER.World,
  first: RAPIER.Collider,
  second: RAPIER.Collider,
): boolean {
  if (first.isSensor() || second.isSensor()) return false;
  let touching = false;
  world.contactPair(first, second, (manifold) => {
    for (let index = 0; index < manifold.numSolverContacts(); index += 1) {
      if (manifold.solverContactDist(index) <= 0) touching = true;
    }
  });
  return touching;
}
