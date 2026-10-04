import type {
  Collider,
  ColliderDesc,
  RigidBody,
  Rotation,
  World,
} from '@dimforge/rapier3d-deterministic';
import RAPIER from '@dimforge/rapier3d-deterministic';

import type { SimulatedCupMotion } from './cup-motion';
import { cupTransformAt, quatFromEuler } from './cup-motion';
import { DEFAULT_CUP_SPEC } from './cup-spec';
import { rotateVectorByQuat } from './result-recognition';
import type { RollPhysicsConfig } from './roll-physics';
import {
  DIE_COLLIDER_RADIUS,
  DIE_SIZE,
  FLOOR_Y,
  rollArea,
  STEP,
} from './roll-simulation-constants';
import { seededNumber } from './seed-expander';

export interface TrayWall {
  collider: Collider;
  inwardX: number;
  inwardZ: number;
}

export interface PhysicsTray {
  floor: Collider;
  walls: TrayWall[];
}

export interface SimDie {
  id: string;
  body: RigidBody;
  collider: Collider;
}

export function createRollWorld(physics: RollPhysicsConfig): World {
  const world = new RAPIER.World({ x: 0, y: physics.gravity, z: 0 });
  world.timestep = STEP;
  // A broad speculative margin consumes wall impact before the real contact.
  // Keep a small look-ahead; visible cup contacts still use CCD.
  world.integrationParameters.normalizedPredictionDistance = 0.02;
  // Keep contact stiffness explicit at the 1/240s step to limit penetration
  // through the thin cup base during shaking.
  world.integrationParameters.contact_natural_frequency = 240;
  return world;
}

export function createTray(world: World, physics: RollPhysicsConfig): PhysicsTray {
  const floorCollider = createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(
      rollArea.halfWidth + rollArea.wallThickness,
      rollArea.floorHalfHeight,
      rollArea.halfDepth + rollArea.wallThickness,
    )
      .setTranslation(0, FLOOR_Y, rollArea.centerZ)
      .setRestitution(physics.floorRestitution)
      .setFriction(physics.floorFriction),
  );
  createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(
      rollArea.halfWidth + rollArea.wallThickness,
      rollArea.ceilingHalfHeight,
      rollArea.halfDepth + rollArea.wallThickness,
    )
      .setTranslation(0, rollArea.ceilingY, rollArea.centerZ)
      .setRestitution(0.08)
      .setFriction(0.62),
  );
  const leftWall = createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(rollArea.wallThickness, rollArea.wallHalfHeight, rollArea.halfDepth)
      .setTranslation(
        -rollArea.halfWidth - rollArea.wallThickness,
        rollArea.wallCenterY,
        rollArea.centerZ,
      )
      .setRestitution(physics.wallRestitution)
      .setFriction(physics.wallFriction),
  );
  const rightWall = createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(rollArea.wallThickness, rollArea.wallHalfHeight, rollArea.halfDepth)
      .setTranslation(
        rollArea.halfWidth + rollArea.wallThickness,
        rollArea.wallCenterY,
        rollArea.centerZ,
      )
      .setRestitution(physics.wallRestitution)
      .setFriction(physics.wallFriction),
  );
  const topWall = createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(
      rollArea.halfWidth + rollArea.wallThickness,
      rollArea.wallHalfHeight,
      rollArea.wallThickness,
    )
      .setTranslation(0, rollArea.wallCenterY, rollArea.topZ - rollArea.wallThickness)
      .setRestitution(physics.wallRestitution * 0.9)
      .setFriction(physics.wallFriction),
  );
  const bottomWall = createFixedCollider(
    world,
    RAPIER.ColliderDesc.cuboid(
      rollArea.halfWidth + rollArea.wallThickness,
      rollArea.wallHalfHeight,
      rollArea.wallThickness,
    )
      .setTranslation(0, rollArea.wallCenterY, rollArea.bottomZ + rollArea.wallThickness)
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
  const radius = rollArea.bottomCornerRadius;
  const walls: TrayWall[] = [];
  // Three tangent segments plus the straight walls approximate each quarter-circle
  // within 0.16 logical px. Only the lower corners are rounded: the rack edge is flat.
  for (const side of [-1, 1]) {
    for (const angle of [Math.PI / 8, Math.PI / 4, (Math.PI * 3) / 8]) {
      const nx = side * Math.cos(angle);
      const nz = Math.sin(angle);
      const x = side * (rollArea.halfWidth - radius) + nx * (radius + rollArea.wallThickness);
      const z = rollArea.bottomZ - radius + nz * (radius + rollArea.wallThickness);
      const collider = createFixedCollider(
        world,
        RAPIER.ColliderDesc.cuboid(rollArea.wallThickness, rollArea.wallHalfHeight, radius * 2)
          .setTranslation(x, rollArea.wallCenterY, z)
          .setRotation(quatFromEuler(0, -Math.atan2(nz, nx), 0))
          .setRestitution(physics.wallRestitution * 0.9)
          .setFriction(physics.wallFriction),
      );
      walls.push({ collider, inwardX: -nx, inwardZ: -nz });
    }
  }
  return walls;
}

export function createDieInCup(
  world: World,
  seed: string,
  index: number,
  diceCount: number,
  cup: SimulatedCupMotion,
  physics: RollPhysicsConfig,
): SimDie {
  const r0 = seededNumber(`${seed}:cup-die-x`, index);
  const r1 = seededNumber(`${seed}:cup-die-z`, index);
  const r2 = seededNumber(`${seed}:cup-die-y`, index);
  const r3 = seededNumber(`${seed}:cup-die-spin`, index);
  const cupPosition = cupTransformAt(cup, 0);
  const localPosition = cupDieStartPosition(index, diceCount);
  const rotation = startingCupRotation(seed, index, r0, r1, r2);
  const halfHeight =
    DIE_COLLIDER_RADIUS +
    (DIE_SIZE / 2 - DIE_COLLIDER_RADIUS) *
      (Math.abs(rotateVectorByQuat([1, 0, 0], rotation)[1]) +
        Math.abs(rotateVectorByQuat([0, 1, 0], rotation)[1]) +
        Math.abs(rotateVectorByQuat([0, 0, 1], rotation)[1]));
  const x = cupPosition.x + localPosition.x;
  const y =
    cupPosition.y -
    DEFAULT_CUP_SPEC.innerHeight / 2 +
    halfHeight +
    0.04 +
    localPosition.level * (DIE_SIZE + 0.13);
  const z = cupPosition.z + localPosition.z;

  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation(rotation)
      .setLinvel((r0 - 0.5) * 0.54, 0, (r1 - 0.5) * 0.48)
      .setAngvel({
        x: (r3 - 0.5) * 1.8,
        y: (r1 - 0.5) * 1.1,
        z: (r0 - 0.5) * 1.8,
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
    .setFriction(0.1);
  const collider = world.createCollider(colliderDesc, body);
  return { id: `die-${index}`, body, collider };
}

function createFixedCollider(world: World, colliderDesc: ColliderDesc): Collider {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  return world.createCollider(colliderDesc, body);
}

function cupDieStartPosition(
  index: number,
  diceCount: number,
): { x: number; z: number; level: number } {
  if (diceCount === 1) return { x: 0, z: 0, level: 0 };
  if (diceCount === 2) return { x: index === 0 ? -0.4 : 0.4, z: 0, level: 0 };
  if (diceCount === 3) {
    const angle = (index * Math.PI * 2) / 3;
    return { x: Math.cos(angle) * 0.55, z: Math.sin(angle) * 0.55, level: 0 };
  }
  if (diceCount === 5) {
    // Leave room around the lower pair so cup contacts can tumble the upper
    // three, instead of shaking a locked four-die bed with one loose die.
    if (index < 2) return { x: index === 0 ? -0.4 : 0.4, z: 0, level: 0 };
    const angle = ((index - 2) * Math.PI * 2) / 3;
    return { x: Math.cos(angle) * 0.55, z: Math.sin(angle) * 0.55, level: 1 };
  }
  return { x: index % 2 ? 0.42 : -0.42, z: index < 2 ? -0.42 : 0.42, level: 0 };
}

function startingCupRotation(
  seed: string,
  index: number,
  a: number,
  b: number,
  c: number,
): Rotation {
  // Select a cube orientation, not a requested outcome. Free physics determines the
  // eventual face. Small initial tilts keep the packed bodies out of each other.
  const orientation = Math.floor(seededNumber(`${seed}:cup-die-orientation`, index) * 24);
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
  const tilt = quatFromEuler((a - 0.5) * 0.12, (b - 0.5) * 0.12, (c - 0.5) * 0.12);
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
