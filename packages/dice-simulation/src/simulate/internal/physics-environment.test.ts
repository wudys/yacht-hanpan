import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, test } from 'bun:test';

import { initializeDeterministicRapierForBun } from '../../rapier/bun';
import { type PhysicsCompletionSnapshot, simulateRollTimeline } from '../simulate-timeline';
import { createCupFrame, createCupMotion, cupTransformAt } from './cup-motion';
import { DEFAULT_CUP_SPEC } from './cup-spec';
import {
  areDiceOutsideCup,
  createPhysicsCup,
  haveDiceClearedCup,
  updatePhysicsCup,
} from './physics-cup';
import { createDieInCup, createRollWorld, createTray } from './physics-environment';
import { rotateVectorByQuat } from './result-recognition';
import { createRollPhysicsConfig } from './roll-physics';
import { DIE_COLLIDER_RADIUS, DIE_SIZE, rollArea } from './roll-simulation-constants';

beforeAll(initializeDeterministicRapierForBun);

test.each([false, true])('preserves material rebound at a direct wall strike (CCD %s)', (ccd) => {
  const physics = { ...createRollPhysicsConfig(), gravity: 0 };
  const world = createRollWorld(physics);
  try {
    createTray(world, physics);
    const { body } = createDieInCup(
      world,
      'wall-rebound',
      0,
      1,
      createCupMotion('wall-rebound', 'classic'),
      physics,
    );
    body.setTranslation({ x: 0, y: 1, z: rollArea.centerZ }, true);
    body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    body.setLinvel({ x: 6, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    body.enableCcd(ccd);
    let rebound = 0;
    for (let step = 0; step < 180; step += 1) {
      world.step();
      rebound = Math.max(rebound, -body.linvel().x);
    }
    // Broad response range around the existing average restitution (~.34).
    // Predictive contacts must not consume almost all impact momentum.
    expect(rebound / 6).toBeGreaterThan(0.2);
    expect(rebound / 6).toBeLessThan(0.5);
  } finally {
    world.free();
  }
});

test('aims the oblique physical mouth with the same rotation as its replay', () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const motion = createCupMotion('coherent-pour-baseline-5-4', 'oblique');
    const cup = createPhysicsCup(world, cupTransformAt(motion, 0), DEFAULT_CUP_SPEC);
    const time = motion.pourAtMs + 750;
    updatePhysicsCup(cup, cupTransformAt(motion, time));
    world.step();
    const q = cup.body.rotation();
    const mouth = rotateVectorByQuat([0, 1, 0], q);
    expect(Math.abs(mouth[2])).toBeGreaterThan(0.04);
    expect(Math.abs(mouth[0])).toBeGreaterThan(0.4);
    const frame = createCupFrame(motion, time);
    [q.x, q.y, q.z, q.w].forEach((value, index) => {
      expect(value).toBeCloseTo(frame.q[index], 4);
    });
  } finally {
    world.free();
  }
});

test('keeps the complete rotating die within one logical pixel of the visible wall during impact', () => {
  let raw: PhysicsCompletionSnapshot | undefined;
  const timeline = simulateRollTimeline(
    {
      rollId: 'fast-wall-contact',
      seed: 'dice-quality-tuning-toss-2-32',
      rolledSlots: [0, 1],
      pourStyle: 'burst',
    },
    (snapshot) => {
      raw = snapshot;
    },
  );
  expect(raw).toBeDefined();
  let maxPenetration = 0;
  for (const die of timeline.dice)
    for (const frame of die.frames.slice(
      0,
      raw!.dice.find((d) => d.slot === die.slot)!.frameIndex + 1,
    )) {
      const q = { x: frame.q[0], y: frame.q[1], z: frame.q[2], w: frame.q[3] };
      const axes: [number, number, number][] = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ];
      const rotated = axes.map((axis) => rotateVectorByQuat(axis, q));
      const support = (axis: number) =>
        DIE_COLLIDER_RADIUS +
        (DIE_SIZE / 2 - DIE_COLLIDER_RADIUS) *
          rotated.reduce((sum, v) => sum + Math.abs(v[axis]), 0);
      maxPenetration = Math.max(
        maxPenetration,
        Math.abs(frame.p[0]) + support(0) - rollArea.halfWidth,
        rollArea.topZ - frame.p[2] + support(2),
        frame.p[2] + support(2) - rollArea.bottomZ,
      );
    }
  expect(maxPenetration).toBeLessThan(DIE_SIZE / 32);
});

test('distinguishes finite cup clearance from crossing the mouth or only its centre', () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const motion = createCupMotion('cup-clearance', 'classic');
    const pose = cupTransformAt(motion, 0);
    const cup = createPhysicsCup(world, pose, DEFAULT_CUP_SPEC);
    const die = createDieInCup(world, 'cup-clearance', 0, 1, motion, createRollPhysicsConfig());
    die.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    const check = (x: number, y: number) => {
      die.body.setTranslation({ x: pose.x + x, y: pose.y + y, z: pose.z }, true);
      world.propagateModifiedBodyPositionsToColliders();
      return [haveDiceClearedCup(world, cup, [die]), areDiceOutsideCup(world, cup, [die])];
    };
    expect(check(0, 0)).toEqual([false, false]);
    expect(check(0, 1.1)).toEqual([false, false]); // Centre past the rim, body still inside.
    expect(check(0, 2)).toEqual([true, true]);
    expect(check(0, -2)).toEqual([false, true]); // A bounced die can be below the cup.
    expect(check(2, 0)).toEqual([false, true]);
    expect(check(1.3, 0)).toEqual([false, false]); // Centre outside the side, body overlaps.
  } finally {
    world.free();
  }
});

test.each([0.003, 0.012])(
  'uses shape clearance despite a predictive rim contact (gap %s)',
  (gap) => {
    const physics = { ...createRollPhysicsConfig(), gravity: 0 };
    const world = createRollWorld(physics);
    try {
      const motion = createCupMotion('predictive-rim-contact', 'classic');
      const cup = createPhysicsCup(world, { x: 0, y: 0, z: 0, tilt: 0, yaw: 0 }, DEFAULT_CUP_SPEC);
      const die = createDieInCup(world, 'predictive-rim-contact', 0, 1, motion, physics);
      die.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      die.body.setTranslation(
        {
          x: DEFAULT_CUP_SPEC.innerRadius,
          y: DEFAULT_CUP_SPEC.innerHeight / 2 + DIE_SIZE / 2 + gap,
          z: 0,
        },
        true,
      );
      die.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      die.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      die.body.enableCcd(false);
      world.step();
      const distances: number[] = [];
      for (const collider of cup.colliders) {
        world.contactPair(die.collider, collider, (manifold) => {
          for (let i = 0; i < manifold.numSolverContacts(); i += 1)
            distances.push(manifold.solverContactDist(i));
        });
      }
      expect(distances.length).toBeGreaterThan(0);
      expect(Math.min(...distances)).toBeGreaterThan(0);
      expect(haveDiceClearedCup(world, cup, [die])).toBe(gap > 0.005);
      expect(areDiceOutsideCup(world, cup, [die])).toBe(gap > 0.005);
    } finally {
      world.free();
    }
  },
);

test('keeps solid-die mass and rotational response when its collider has rounded edges', () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const seed = 'solid-die-mass';
    const die = createDieInCup(
      world,
      seed,
      0,
      1,
      createCupMotion(seed, 'classic'),
      createRollPhysicsConfig(),
    );
    // Unit-density solid cube approximation, independent of the rounded inner core.
    expect(die.body.mass()).toBeCloseTo(DIE_SIZE ** 3, 5);
    die.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    die.body.applyTorqueImpulse({ x: die.body.mass() * 0.1, y: 0, z: 0 }, true);
    expect(die.body.angvel().x).toBeCloseTo(0.6 / DIE_SIZE ** 2, 4);
    expect(die.body.angvel().y).toBeCloseTo(0, 4);
    expect(die.body.angvel().z).toBeCloseTo(0, 4);
  } finally {
    world.free();
  }
});

test.each([1, 2, 3, 4, 5])('starts %i dice without intersecting each other or the cup', (count) => {
  let deepestContact = 0;
  for (let sequence = 0; sequence < 20; sequence += 1) {
    const seed = `cup-capacity-${count}-${sequence}`;
    const world = new RAPIER.World({ x: 0, y: -9.8, z: 0 });
    try {
      const motion = createCupMotion(seed, 'classic');
      const cup = createPhysicsCup(world, cupTransformAt(motion, 0), DEFAULT_CUP_SPEC);
      const physics = createRollPhysicsConfig();
      const dice = Array.from({ length: count }, (_, i) =>
        createDieInCup(world, seed, i, count, motion, physics),
      );
      dice.forEach((die, i) => {
        for (const other of [...cup.colliders, ...dice.slice(i + 1).map((d) => d.collider)]) {
          const contact = die.collider.contactCollider(other, 0);
          if (contact) deepestContact = Math.min(deepestContact, contact.distance);
        }
      });
    } finally {
      world.free();
    }
  }
  expect(deepestContact).toBeGreaterThanOrEqual(-0.001);
});

test('pairs each physical side wall with its inward direction and excludes the ceiling', () => {
  const world = new RAPIER.World({ x: 0, y: -9.8, z: 0 });
  try {
    const tray = createTray(world, createRollPhysicsConfig());
    const sides = tray.walls.filter((wall) => wall.inwardX === 0 || wall.inwardZ === 0);
    expect(sides).toHaveLength(4);
    const positions = sides.map(({ collider, inwardX, inwardZ }) => {
      const p = collider.translation();
      return { x: p.x, y: p.y, z: p.z, inwardX, inwardZ };
    });
    for (const wall of positions) expect(wall.y).toBeCloseTo(rollArea.wallCenterY, 4);
    const left = positions.find((wall) => wall.x < -rollArea.halfWidth)!;
    const right = positions.find((wall) => wall.x > rollArea.halfWidth)!;
    const top = positions.find((wall) => wall.z < rollArea.topZ)!;
    const bottom = positions.find((wall) => wall.z > rollArea.bottomZ)!;
    expect([left.inwardX, left.inwardZ]).toEqual([1, 0]);
    expect([right.inwardX, right.inwardZ]).toEqual([-1, 0]);
    expect([top.inwardX, top.inwardZ]).toEqual([0, 1]);
    expect([bottom.inwardX, bottom.inwardZ]).toEqual([0, -1]);
  } finally {
    world.free();
  }
});

test('blocks the rounded lower tray corners without narrowing the straight side lanes', () => {
  const world = new RAPIER.World({ x: 0, y: -9.8, z: 0 });
  try {
    const { walls } = createTray(world, createRollPhysicsConfig());
    for (const side of [-1, 1]) {
      const corner = { x: side * (rollArea.halfWidth - 0.02), y: 0, z: rollArea.bottomZ - 0.02 };
      expect(walls.some(({ collider }) => collider.containsPoint(corner))).toBe(true);
      const lane = { x: corner.x, y: 0, z: rollArea.centerZ };
      expect(walls.some(({ collider }) => collider.containsPoint(lane))).toBe(false);
    }
  } finally {
    world.free();
  }
});

test.each([13, 20, 28, 29, 40, 48])(
  'keeps release case %i below the ceiling instead of resting on its roof',
  (sequence) => {
    let raw: PhysicsCompletionSnapshot | undefined;
    simulateRollTimeline(
      {
        rollId: `ceiling-regression-${sequence}`,
        seed: `dice-quality-tuning-toss-1-${sequence}`,
        rolledSlots: [0],
        pourStyle: 'burst',
      },
      (snapshot) => {
        raw = snapshot;
      },
    );
    expect(raw).toBeDefined();
    expect(raw!.dice[0].p[1]).toBeLessThan(rollArea.ceilingY - rollArea.ceilingHalfHeight);
  },
);
