import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, spyOn, test } from 'bun:test';

import { cupWallVertices, DEFAULT_CUP_GEOMETRY } from '../../contract/cup-geometry';
import { initializeDeterministicRapierForBun } from '../../rapier/bun';
import { createCupMotion } from './cup-motion';
import {
  applyCupPourAssist,
  areDiceOutsideCup,
  createCupShakeLid,
  createPhysicsCup,
  haveDiceClearedCup,
  stepWorldWithCup,
  updatePhysicsCup,
} from './physics-cup';
import { createRollWorld } from './physics-environment';
import { createRollPhysicsConfig } from './roll-physics';
import { STEP } from './roll-simulation-constants';

beforeAll(initializeDeterministicRapierForBun);

test('keeps default walls isolated from public vertices and mutable custom specs across worlds', () => {
  const custom = {
    ...DEFAULT_CUP_GEOMETRY,
    innerRadius: 1.8,
    bottomRadius: 1.6,
    innerHeight: 3,
    segments: 12,
  };
  const defaultExpected = Array.from({ length: DEFAULT_CUP_GEOMETRY.segments }, (_, segment) =>
    sortedVertices(cupWallVertices(segment)),
  );
  const publicVertices = cupWallVertices(0);
  publicVertices.fill(999);
  expect(sortedVertices(cupWallVertices(0))).toEqual(defaultExpected[0]);

  for (let sequence = 0; sequence < 4; sequence += 1) {
    const spec = sequence % 2 === 0 ? DEFAULT_CUP_GEOMETRY : custom;
    const world = createRollWorld(createRollPhysicsConfig());
    try {
      const cup = createPhysicsCup(world, { x: 0, y: 0, z: 0, tilt: 0, yaw: 0 }, spec);
      if (spec === DEFAULT_CUP_GEOMETRY) expect(cup.geometry).toBe(DEFAULT_CUP_GEOMETRY);
      expect(cup.colliders).toHaveLength(spec.segments + 1);
      cup.colliders.slice(1).forEach((wall, segment) => {
        const vertices = wall.vertices();
        expect(sortedVertices(vertices)).toEqual(
          spec === DEFAULT_CUP_GEOMETRY
            ? defaultExpected[segment]
            : sortedVertices(cupWallVertices(segment, spec)),
        );
        // A geometry buffer read from one collider cannot poison a later world.
        vertices.fill(999);
      });
    } finally {
      world.free();
    }
    if (spec === custom) {
      custom.innerRadius += 0.1;
      custom.bottomRadius += 0.1;
      custom.innerHeight += 0.2;
    }
  }
});

test.each([0.08, 0.1, 0.16])(
  'keeps the shake lid independent of base thickness %s',
  (baseThickness) => {
    const world = createRollWorld(createRollPhysicsConfig());
    try {
      const spec = { ...DEFAULT_CUP_GEOMETRY, baseThickness };
      const cup = createPhysicsCup(world, { x: 0, y: 0, z: 0, tilt: 0, yaw: 0 }, spec);
      const base = cup.colliders[0];
      const lid = createCupShakeLid(world, cup);
      expect(base.halfHeight()).toBeCloseTo(baseThickness / 2, 6);
      expect(base.translation().y).toBeCloseTo(-spec.innerHeight / 2 - baseThickness / 2, 6);
      expect(base.radius()).toBeCloseTo(spec.bottomRadius + spec.wallThickness, 6);
      expect(lid.halfHeight()).toBeCloseTo(0.04, 6);
      expect(lid.translation().y).toBeCloseTo(spec.innerHeight / 2 + 0.04, 6);
      // The fixed mouth constraint contains its original interior volume but must
      // not gain an extra collision region above the rim when the base grows.
      const inside = new RAPIER.Ray(
        { x: 0, y: spec.innerHeight / 2 + 0.07, z: 0 },
        { x: 1, y: 0, z: 0 },
      );
      const above = new RAPIER.Ray(
        { x: 0, y: spec.innerHeight / 2 + 0.09, z: 0 },
        { x: 1, y: 0, z: 0 },
      );
      expect(lid.castRay(inside, 2, true)).toBe(0);
      expect(lid.castRay(above, 2, true)).toBe(-1);
    } finally {
      world.free();
    }
  },
);

test.each([
  { name: 'tall cup below its mouth', spec: { innerHeight: 4 }, x: 0, y: 1.5 },
  { name: 'wide cup within its side', spec: { innerRadius: 3, bottomRadius: 3 }, x: 2, y: 0 },
  { name: 'reinforced finite base', spec: { innerRadius: 3, baseThickness: 0.8 }, x: 1.6, y: -1.5 },
])('uses actual custom geometry for $name', ({ spec, x, y }) => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const cup = createPhysicsCup(
      world,
      { x: 0, y: 0, z: 0, tilt: 0, yaw: 0 },
      { ...DEFAULT_CUP_GEOMETRY, ...spec },
    );
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, 0));
    const collider = world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(0.235, 0.235, 0.235, 0.025),
      body,
    );
    const dice = [{ id: 'inside-custom', body, collider }];
    expect(haveDiceClearedCup(cup, dice)).toBe(false);
    expect(areDiceOutsideCup(cup, dice)).toBe(false);
  } finally {
    world.free();
  }
});

test('retains its creation geometry for subsequent lid and clearance queries', () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const spec = { ...DEFAULT_CUP_GEOMETRY, innerHeight: 4, innerRadius: 3 };
    const expected = { ...spec };
    const cup = createPhysicsCup(world, { x: 0, y: 0, z: 0, tilt: 0, yaw: 0 }, spec);
    spec.innerHeight = 1;
    spec.innerRadius = 0.5;
    spec.baseThickness = 0.8;
    const lid = createCupShakeLid(world, cup);
    expect(cup.geometry).toEqual(expected);
    expect(Object.isFrozen(cup.geometry)).toBe(true);
    expect(cup.geometry).not.toBe(spec);
    expect(lid.translation().y).toBeCloseTo(2.04, 6);
    expect(lid.radius()).toBeCloseTo(3.08, 6);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1.5, 0));
    const collider = world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(0.235, 0.235, 0.235, 0.025),
      body,
    );
    expect(haveDiceClearedCup(cup, [{ id: 'snapshot', body, collider }])).toBe(false);
    expect(areDiceOutsideCup(cup, [{ id: 'snapshot', body, collider }])).toBe(false);
  } finally {
    world.free();
  }
});

test.each([
  { spec: { innerHeight: 4 }, y: -1.5, z: 0 },
  { spec: { innerRadius: 3 }, y: 0, z: 2.5 },
])('assists only within the actual custom cup interior ($y, $z)', ({ spec, y, z }) => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const cup = createPhysicsCup(
      world,
      { x: 0, y: 0, z: 0, tilt: Math.PI, yaw: 0 },
      { ...DEFAULT_CUP_GEOMETRY, ...spec },
    );
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, y, z));
    const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(0.26, 0.26, 0.26), body);
    const motion = createCupMotion('custom-pour-assist', 'burst');
    applyCupPourAssist(
      cup,
      [{ id: 'custom-pour', body, collider }],
      motion,
      motion.pourAtMs + motion.pourAssistDelayMs + 100,
      new Set(),
    );
    expect(body.linvel().y).toBeCloseTo(-20 * STEP, 6);
    expect(body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
  } finally {
    world.free();
  }
});

test('interpolates cup pose across two actual substeps and restores the outer timestep', () => {
  const world = createRollWorld(createRollPhysicsConfig());
  const step = world.step.bind(world);
  const observations: {
    timestep: number;
    x: number;
    q: RAPIER.Rotation;
    solverIterations: number;
  }[] = [];
  const cup = createPhysicsCup(world, { x: 0, y: 0, z: 0, tilt: 0, yaw: 0 }, DEFAULT_CUP_GEOMETRY);
  const observer = spyOn(world, 'step').mockImplementation(() => {
    step();
    observations.push({
      timestep: world.timestep,
      x: cup.body.translation().x,
      q: cup.body.rotation(),
      solverIterations: world.numSolverIterations,
    });
  });
  try {
    updatePhysicsCup(cup, { x: 0.6, y: 0, z: 0, tilt: 0.4, yaw: 0 });
    stepWorldWithCup(world, cup);
    expect(observations).toHaveLength(2);
    observations.forEach((sample, index) => {
      expect(sample.timestep).toBeCloseTo(STEP / 2, 8);
      expect(sample.solverIterations).toBe(2);
      expect(sample.x).toBeCloseTo(0.3 * (index + 1), 6);
      expect(sample.q.z).toBeCloseTo(Math.sin(0.1 * (index + 1)), 6);
      expect(sample.q.w).toBeCloseTo(Math.cos(0.1 * (index + 1)), 6);
    });
    expect(observations.reduce((sum, sample) => sum + sample.timestep, 0)).toBeCloseTo(STEP, 8);
    expect(world.timestep).toBeCloseTo(STEP, 8);
  } finally {
    observer.mockRestore();
    world.free();
  }
});

function sortedVertices(vertices: Float32Array): number[][] {
  const points: number[][] = [];
  for (let index = 0; index < vertices.length; index += 3) {
    points.push(Array.from(vertices.subarray(index, index + 3)));
  }
  return points.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
}
