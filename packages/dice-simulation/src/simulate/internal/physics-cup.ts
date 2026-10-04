import type { Collider, RigidBody, Rotation, World } from '@dimforge/rapier3d-deterministic';
import RAPIER from '@dimforge/rapier3d-deterministic';

import { cupWallVertices } from '../../contract/cup-geometry';
import type { CupTransform, SimulatedCupMotion } from './cup-motion';
import { quatFromEuler } from './cup-motion';
import { type CupSpec, DEFAULT_CUP_SPEC } from './cup-spec';
import type { SimDie } from './physics-environment';
import { rotateVectorByQuat } from './result-recognition';
import { DIE_COLLIDER_RADIUS, DIE_SIZE, STEP } from './roll-simulation-constants';

export interface PhysicsCup {
  body: RigidBody;
  colliders: Collider[];
}

export function createPhysicsCup(
  world: World,
  initialTransform: CupTransform,
  spec: CupSpec,
): PhysicsCup {
  const body = world.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(initialTransform.x, initialTransform.y, initialTransform.z)
      .setRotation(quatFromEuler(0, initialTransform.yaw, initialTransform.tilt)),
  );
  const colliders = [
    world.createCollider(
      RAPIER.ColliderDesc.cylinder(spec.baseThickness / 2, spec.bottomRadius + spec.wallThickness)
        .setTranslation(0, -spec.innerHeight / 2 - spec.baseThickness / 2, 0)
        .setRestitution(0.03)
        .setFriction(0.3),
      body,
    ),
  ];
  for (let segment = 0; segment < spec.segments; segment += 1) {
    const shape = RAPIER.ColliderDesc.convexHull(cupWallVertices(segment, spec));
    if (!shape) throw new Error('Invalid cup wall geometry');
    colliders.push(world.createCollider(shape.setRestitution(0.03).setFriction(0.3), body));
  }
  return { body, colliders };
}

/** Invisible mouth constraint attached to the cup during shaking and gathering. */
export function createCupShakeLid(world: World, cup: PhysicsCup, spec: CupSpec): Collider {
  const lid = world.createCollider(
    RAPIER.ColliderDesc.cylinder(spec.baseThickness / 2, spec.innerRadius + spec.wallThickness)
      .setTranslation(0, spec.innerHeight / 2 + spec.baseThickness / 2, 0)
      .setRestitution(0.03)
      .setFriction(0.3),
    cup.body,
  );
  cup.colliders.push(lid);
  return lid;
}

export function removeCupShakeLid(world: World, cup: PhysicsCup, lid: Collider): void {
  cup.colliders = cup.colliders.filter((collider) => collider !== lid);
  world.removeCollider(lid, false);
}

export function updatePhysicsCup(cupBody: PhysicsCup, transform: CupTransform): void {
  cupBody.body.setNextKinematicTranslation({ x: transform.x, y: transform.y, z: transform.z });
  cupBody.body.setNextKinematicRotation(quatFromEuler(0, transform.yaw, transform.tilt));
}

/** Resolve fast cup contacts without changing the outer tick or rollout timestep. */
export function stepWorldWithCup(world: World, cup: PhysicsCup): void {
  const substeps = 4;
  const from = cup.body.translation();
  const to = cup.body.nextTranslation();
  const rotationFrom = cup.body.rotation();
  const rotationTo = cup.body.nextRotation();
  world.timestep = STEP / substeps;
  for (let part = 1; part <= substeps; part += 1) {
    const alpha = part / substeps;
    cup.body.setNextKinematicTranslation({
      x: from.x + (to.x - from.x) * alpha,
      y: from.y + (to.y - from.y) * alpha,
      z: from.z + (to.z - from.z) * alpha,
    });
    cup.body.setNextKinematicRotation(slerpRotation(rotationFrom, rotationTo, alpha));
    world.step();
  }
  world.timestep = STEP;
}

function slerpRotation(from: Rotation, to: Rotation, alpha: number): Rotation {
  if (alpha === 1) return to;
  const dot = from.x * to.x + from.y * to.y + from.z * to.z + from.w * to.w;
  const sign = dot < 0 ? -1 : 1;
  const cosine = Math.abs(dot);
  if (cosine >= 1) return from;
  const sineSquared = 1 - cosine * cosine;
  const sine = Math.sqrt(sineSquared);
  const angle = Math.atan2(sine, cosine);
  const linear = sineSquared <= Number.EPSILON;
  const a = linear ? 1 - alpha : Math.sin((1 - alpha) * angle) / sine;
  const b = (linear ? alpha : Math.sin(alpha * angle) / sine) * sign;
  const q = {
    x: from.x * a + to.x * b,
    y: from.y * a + to.y * b,
    z: from.z * a + to.z * b,
    w: from.w * a + to.w * b,
  };
  if (!linear) return q;
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

export function removePhysicsCup(world: World, cupBody: PhysicsCup): void {
  cupBody.colliders.forEach((collider) => world.removeCollider(collider, false));
  world.removeRigidBody(cupBody.body);
}

/** Brief, face-independent assistance inside the tilted cup, never a rollout drive. */
export function applyCupPourAssist(
  cup: PhysicsCup,
  dice: readonly SimDie[],
  motion: SimulatedCupMotion,
  timeMs: number,
  exitedDice: ReadonlySet<string>,
): void {
  const start = motion.pourAtMs + motion.pourAssistDelayMs;
  if (timeMs < start || timeMs >= start + 450) return;
  const center = cup.body.translation();
  const axis = rotateVectorByQuat([0, 1, 0], cup.body.rotation());
  if (axis[1] >= 0) return;
  for (const die of dice) {
    if (exitedDice.has(die.id)) continue;
    const p = die.body.translation();
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const dz = p.z - center.z;
    const along = dx * axis[0] + dy * axis[1] + dz * axis[2];
    if (
      Math.abs(along) >= DEFAULT_CUP_SPEC.innerHeight / 2 ||
      dx * dx + dy * dy + dz * dz - along * along >= DEFAULT_CUP_SPEC.innerRadius ** 2
    )
      continue;
    // Equal acceleration regardless of count, mass, orientation or face value.
    // Stop at the mouth centre plane; the remaining exit and flight stay unassisted.
    const impulse = die.body.mass() * 20 * STEP;
    die.body.applyImpulse(
      { x: axis[0] * impulse, y: axis[1] * impulse, z: axis[2] * impulse },
      true,
    );
  }
}

/** Full rounded shape outside the mouth, with no remaining cup contact. */
export function haveDiceClearedCup(_world: World, cup: PhysicsCup, dice: SimDie[]): boolean {
  return dice.every(
    (die) =>
      dieBoundsAlongCupAxis(cup, die, [0, 1, 0]).min > DEFAULT_CUP_SPEC.innerHeight / 2 + 0.005 &&
      !cup.colliders.some((collider) => die.collider.contactCollider(collider, 0.005)),
  );
}

/** Conservative finite-volume clearance, used only after every die crossed the mouth. */
export function areDiceOutsideCup(_world: World, cup: PhysicsCup, dice: SimDie[]): boolean {
  const radius =
    Math.max(DEFAULT_CUP_SPEC.innerRadius, DEFAULT_CUP_SPEC.bottomRadius) +
    DEFAULT_CUP_SPEC.wallThickness;
  return dice.every((die) => {
    const x = dieBoundsAlongCupAxis(cup, die, [1, 0, 0]);
    const y = dieBoundsAlongCupAxis(cup, die, [0, 1, 0]);
    const z = dieBoundsAlongCupAxis(cup, die, [0, 0, 1]);
    const outside =
      x.min > radius + 0.005 ||
      x.max < -radius - 0.005 ||
      z.min > radius + 0.005 ||
      z.max < -radius - 0.005 ||
      y.min > DEFAULT_CUP_SPEC.innerHeight / 2 + 0.005 ||
      y.max < -DEFAULT_CUP_SPEC.innerHeight / 2 - DEFAULT_CUP_SPEC.baseThickness - 0.005;
    // Solver manifolds also contain predictive contacts with a positive gap.
    // Only current shape separation within the clearance tolerance blocks exit.
    return (
      outside && !cup.colliders.some((collider) => die.collider.contactCollider(collider, 0.005))
    );
  });
}

function dieBoundsAlongCupAxis(cup: PhysicsCup, die: SimDie, axis: [number, number, number]) {
  const center = cup.body.translation();
  const normal = rotateVectorByQuat(axis, cup.body.rotation());
  const dot = (v: number[]) => v[0] * normal[0] + v[1] * normal[1] + v[2] * normal[2];
  const p = die.body.translation();
  const q = die.body.rotation();
  const support =
    DIE_COLLIDER_RADIUS +
    (DIE_SIZE / 2 - DIE_COLLIDER_RADIUS) *
      (Math.abs(dot(rotateVectorByQuat([1, 0, 0], q))) +
        Math.abs(dot(rotateVectorByQuat([0, 1, 0], q))) +
        Math.abs(dot(rotateVectorByQuat([0, 0, 1], q))));
  const projectedCenter = dot([p.x - center.x, p.y - center.y, p.z - center.z]);
  return { min: projectedCenter - support, max: projectedCenter + support };
}
