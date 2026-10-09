import type {
  Collider,
  ColliderDesc,
  RigidBody,
  Rotation,
  World,
} from '@dimforge/rapier3d-deterministic';
import RAPIER from '@dimforge/rapier3d-deterministic';

import { DEFAULT_CUP_GEOMETRY } from '../../contract/cup-geometry';
import type { CupMotionState, CupTransform } from './cup/cup-motion';
import { cupTransformAt } from './cup/cup-motion';
import { createInitialDiceLayout, type InitialDiePlacement } from './initial-dice-layout';
import type { RollPhysicsConfig } from './physics-config';
import {
  DIE_COLLIDER_RADIUS,
  DIE_SIZE,
  FIXED_STEP_SECONDS,
  FLOOR_Y,
  trayGeometry,
} from './roll-simulation-constants';
import { seededNumber } from './seed-expander';
import { quatFromEuler, rotateVectorByQuat } from './simulation-math';

export interface TrayWall {
  collider: Collider;
  inwardX: number;
  inwardZ: number;
}

export interface PhysicsTray {
  floor: Collider;
  walls: TrayWall[];
}

export interface PhysicsDie {
  id: string;
  body: RigidBody;
  collider: Collider;
}

export function createRollWorld(physics: RollPhysicsConfig): World {
  const world = new RAPIER.World({ x: 0, y: physics.gravity, z: 0 });
  world.timestep = FIXED_STEP_SECONDS;
  world.numSolverIterations = 2;
  // A broad speculative margin consumes wall impact before the real contact.
  // Keep a small look-ahead; visible cup contacts still use CCD.
  world.integrationParameters.normalizedPredictionDistance = 0.02;
  // Keep contact stiffness explicit for the moving cup's substeps.
  world.integrationParameters.contact_natural_frequency = 240;
  return world;
}

export function createTray(world: World, physics: RollPhysicsConfig): PhysicsTray {
  const floorCollider = createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(
      trayGeometry.halfWidth + trayGeometry.wallThickness,
      trayGeometry.floorHalfHeight,
      trayGeometry.halfDepth + trayGeometry.wallThickness,
    )
      .setTranslation(0, FLOOR_Y, trayGeometry.centerZ)
      .setRestitution(physics.floorRestitution)
      .setFriction(physics.floorFriction),
  );
  createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(
      trayGeometry.halfWidth + trayGeometry.wallThickness,
      trayGeometry.ceilingHalfHeight,
      trayGeometry.halfDepth + trayGeometry.wallThickness,
    )
      .setTranslation(0, trayGeometry.ceilingY, trayGeometry.centerZ)
      .setRestitution(0.08)
      .setFriction(0.62),
  );
  const leftWall = createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(
      trayGeometry.wallThickness,
      trayGeometry.wallHalfHeight,
      trayGeometry.halfDepth,
    )
      .setTranslation(
        -trayGeometry.halfWidth - trayGeometry.wallThickness,
        trayGeometry.wallCenterY,
        trayGeometry.centerZ,
      )
      .setRestitution(physics.wallRestitution)
      .setFriction(physics.wallFriction),
  );
  const rightWall = createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(
      trayGeometry.wallThickness,
      trayGeometry.wallHalfHeight,
      trayGeometry.halfDepth,
    )
      .setTranslation(
        trayGeometry.halfWidth + trayGeometry.wallThickness,
        trayGeometry.wallCenterY,
        trayGeometry.centerZ,
      )
      .setRestitution(physics.wallRestitution)
      .setFriction(physics.wallFriction),
  );
  const topWall = createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(
      trayGeometry.halfWidth + trayGeometry.wallThickness,
      trayGeometry.wallHalfHeight,
      trayGeometry.wallThickness,
    )
      .setTranslation(0, trayGeometry.wallCenterY, trayGeometry.topZ - trayGeometry.wallThickness)
      .setRestitution(physics.wallRestitution * 0.9)
      .setFriction(physics.wallFriction),
  );
  const bottomWall = createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(
      trayGeometry.halfWidth + trayGeometry.wallThickness,
      trayGeometry.wallHalfHeight,
      trayGeometry.wallThickness,
    )
      .setTranslation(
        0,
        trayGeometry.wallCenterY,
        trayGeometry.bottomZ + trayGeometry.wallThickness,
      )
      .setRestitution(physics.wallRestitution * 0.9)
      .setFriction(physics.wallFriction),
  );
  return {
    floor: floorCollider,
    walls: [
      { collider: leftWall, inwardX: 1, inwardZ: 0 },
      { collider: rightWall, inwardX: -1, inwardZ: 0 },
      { collider: topWall, inwardX: 0, inwardZ: 1 },
      { collider: bottomWall, inwardX: 0, inwardZ: -1 },
      ...createLowerCornerWalls(world, physics),
    ],
  };
}

function createLowerCornerWalls(world: World, physics: RollPhysicsConfig): TrayWall[] {
  const radius = trayGeometry.bottomCornerRadius;
  const walls: TrayWall[] = [];
  // Three tangent segments plus the straight walls approximate each quarter-circle
  // within 0.16 logical px. Only the lower corners are rounded: the rack edge is flat.
  for (const side of [-1, 1]) {
    for (const angle of [Math.PI / 8, Math.PI / 4, (Math.PI * 3) / 8]) {
      const nx = side * Math.cos(angle);
      const nz = Math.sin(angle);
      const x =
        side * (trayGeometry.halfWidth - radius) + nx * (radius + trayGeometry.wallThickness);
      const z = trayGeometry.bottomZ - radius + nz * (radius + trayGeometry.wallThickness);
      const collider = createFixedCollider(
        world,
        RAPIER.ColliderDesc.cuboid(
          trayGeometry.wallThickness,
          trayGeometry.wallHalfHeight,
          radius * 2,
        )
          .setTranslation(x, trayGeometry.wallCenterY, z)
          .setRotation(quatFromEuler(0, -Math.atan2(nz, nx), 0))
          .setRestitution(physics.wallRestitution * 0.9)
          .setFriction(physics.wallFriction),
      );
      walls.push({ collider, inwardX: -nx, inwardZ: -nz });
    }
  }
  return walls;
}

export function createDiceInCup(
  world: World,
  seed: string,
  diceCount: number,
  cupMotion: CupMotionState,
  physics: RollPhysicsConfig,
): PhysicsDie[] {
  const placements = createInitialDiceLayout(seed, diceCount);
  const cupPosition = cupTransformAt(cupMotion, 0);
  return placements.map((placement, dieIndex) =>
    createDieInCup(world, seed, dieIndex, placement, cupPosition, physics),
  );
}

function createDieInCup(
  world: World,
  seed: string,
  dieIndex: number,
  placement: InitialDiePlacement,
  cupPosition: Pick<CupTransform, 'x' | 'y' | 'z'>,
  physics: RollPhysicsConfig,
): PhysicsDie {
  const xSample = seededNumber(`${seed}:cup-die-x`, dieIndex);
  const zSample = seededNumber(`${seed}:cup-die-z`, dieIndex);
  const tiltSample = seededNumber(`${seed}:cup-die-y`, dieIndex);
  const spinSample = seededNumber(`${seed}:cup-die-spin`, dieIndex);
  const rotation = createInitialDieRotation(seed, dieIndex, xSample, zSample, tiltSample);
  const halfHeight =
    DIE_COLLIDER_RADIUS +
    (DIE_SIZE / 2 - DIE_COLLIDER_RADIUS) *
      (Math.abs(rotateVectorByQuat([1, 0, 0], rotation)[1]) +
        Math.abs(rotateVectorByQuat([0, 1, 0], rotation)[1]) +
        Math.abs(rotateVectorByQuat([0, 0, 1], rotation)[1]));
  const x = cupPosition.x + placement.x;
  const y =
    cupPosition.y -
    DEFAULT_CUP_GEOMETRY.innerHeight / 2 +
    halfHeight +
    0.04 +
    placement.layer * (DIE_SIZE + 0.13);
  const z = cupPosition.z + placement.z;

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation(rotation)
      .setLinvel((xSample - 0.5) * 0.54, 0, (zSample - 0.5) * 0.48)
      .setAngvel({
        x: (spinSample - 0.5) * 1.8,
        y: (zSample - 0.5) * 1.1,
        z: (xSample - 0.5) * 1.8,
      })
      .setLinearDamping(physics.linearDamping)
      .setAngularDamping(physics.angularDamping)
      .setAdditionalSolverIterations(0)
      .setCcdEnabled(true),
  );
  const colliderDesc = RAPIER.ColliderDesc.roundCuboid(
    DIE_SIZE / 2 - DIE_COLLIDER_RADIUS,
    DIE_SIZE / 2 - DIE_COLLIDER_RADIUS,
    DIE_SIZE / 2 - DIE_COLLIDER_RADIUS,
    DIE_COLLIDER_RADIUS,
  )
    // Rounded-collider automatic mass omits the border. Use the complete solid
    // die's box approximation so changing bevels does not hollow out its inertia.
    .setMassProperties(
      DIE_SIZE ** 3,
      { x: 0, y: 0, z: 0 },
      {
        x: DIE_SIZE ** 5 / 6,
        y: DIE_SIZE ** 5 / 6,
        z: DIE_SIZE ** 5 / 6,
      },
      { x: 0, y: 0, z: 0, w: 1 },
    )
    .setRestitution(0.175)
    // Max preserves the higher felt/wall grip while die-die contacts use this lower friction.
    .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max)
    .setFriction(0.06);
  const collider = world.createCollider(colliderDesc, body);
  return { id: `die-${dieIndex}`, body, collider };
}

function createFixedCollider(world: World, colliderDesc: ColliderDesc): Collider {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  return world.createCollider(colliderDesc, body);
}

function createInitialDieRotation(
  seed: string,
  dieIndex: number,
  xTiltSample: number,
  yTiltSample: number,
  zTiltSample: number,
): Rotation {
  // Select a cube orientation, not a requested outcome. Free physics determines the
  // eventual face. Small initial tilts keep the packed bodies out of each other.
  const orientation = Math.floor(seededNumber(`${seed}:cup-die-orientation`, dieIndex) * 24);
  const bases = [
    [0, 0],
    [Math.PI / 2, 0],
    [Math.PI, 0],
    [-Math.PI / 2, 0],
    [0, Math.PI / 2],
    [0, -Math.PI / 2],
  ] as const;
  const [x, z] = bases[Math.floor(orientation / 4)]!;
  const base = quatFromEuler(x, 0, z);
  const yaw = quatFromEuler(0, ((orientation % 4) * Math.PI) / 2, 0);
  const tilt = quatFromEuler(
    (xTiltSample - 0.5) * 0.12,
    (yTiltSample - 0.5) * 0.12,
    (zTiltSample - 0.5) * 0.12,
  );
  return multiplyRotation(tilt, multiplyRotation(yaw, base));
}

function multiplyRotation(a: Rotation, b: Rotation): Rotation {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}
