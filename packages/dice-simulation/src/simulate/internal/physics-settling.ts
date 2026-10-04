import type {
  Collider,
  RigidBody,
  Rotation,
  Vector,
  World,
} from '@dimforge/rapier3d-deterministic';

import { hasSolverContact } from './contact-query';
import type { TrayWall } from './physics-environment';
import { rotateVectorByQuat, topFaceAlignment } from './result-recognition';
import { DIE_SIZE, FLOOR_TOP_Y } from './roll-simulation-constants';
import { quatDistance, type QuaternionTuple, type VectorTuple } from './simulation-math';

export const REST_LINEAR_SPEED = 0.045;
export const REST_ANGULAR_SPEED = 0.18;
export interface RestSimulationDie {
  id: string;
  body: RigidBody;
  collider: Collider;
}

export interface GroundEdgeReleaseState {
  stationarySinceMs: number | null;
  lastReleasedAtMs: number;
  anchorPosition: VectorTuple | null;
  anchorRotation: QuaternionTuple | null;
  targetFaceNormal: VectorTuple | null;
}

export function releaseRestingGroundEdges(
  world: World,
  dice: RestSimulationDie[],
  floor: Collider,
  clockMs: number,
  states: Map<string, GroundEdgeReleaseState>,
  walls: TrayWall[],
): void {
  const settleDelayMs = 50;
  const cooldownMs = 220;

  dice.forEach((die) => {
    const position = die.body.translation();
    const rotation = die.body.rotation();
    const positionTuple: VectorTuple = [position.x, position.y, position.z];
    const rotationTuple: QuaternionTuple = [rotation.x, rotation.y, rotation.z, rotation.w];
    const state = states.get(die.id) ?? {
      stationarySinceMs: null,
      lastReleasedAtMs: Number.NEGATIVE_INFINITY,
      anchorPosition: null,
      anchorRotation: null,
      targetFaceNormal: null,
    };
    const elevated = position.y - (FLOOR_TOP_Y + DIE_SIZE / 2) > DIE_SIZE * 0.32;
    const isEdgeCandidate = elevated || topFaceAlignment(rotation) <= 0.9;

    if (!isEdgeCandidate) {
      state.stationarySinceMs = null;
      state.anchorPosition = null;
      state.anchorRotation = null;
      state.targetFaceNormal = null;
      states.set(die.id, state);
      return;
    }

    if (
      state.stationarySinceMs === null ||
      state.anchorPosition === null ||
      state.anchorRotation === null
    ) {
      state.stationarySinceMs = clockMs;
      state.anchorPosition = positionTuple;
      state.anchorRotation = rotationTuple;
      state.targetFaceNormal = nearestFaceNormal(rotation);
      states.set(die.id, state);
      return;
    }

    const linear = die.body.linvel();
    const angular = die.body.angvel();
    // Another contact or the wall helper may have just added momentum before
    // the next world step. An unchanged pose alone does not mean the die rests.
    const visiblyStationary =
      Math.hypot(linear.x, linear.y, linear.z) < 0.2 &&
      Math.hypot(angular.x, angular.y, angular.z) < 0.6 &&
      Math.hypot(
        position.x - state.anchorPosition[0],
        position.y - state.anchorPosition[1],
        position.z - state.anchorPosition[2],
      ) < 0.004 &&
      quatDistance(state.anchorRotation, rotationTuple) < 0.012;
    if (!visiblyStationary) {
      state.stationarySinceMs = clockMs;
      state.anchorPosition = positionTuple;
      state.anchorRotation = rotationTuple;
      state.targetFaceNormal = nearestFaceNormal(rotation);
      states.set(die.id, state);
      return;
    }

    const supportColliders = [
      floor,
      ...dice.filter((candidate) => candidate !== die).map((candidate) => candidate.collider),
    ];
    if (!hasLowerSupportContact(world, die.collider, supportColliders)) {
      state.stationarySinceMs = null;
      state.anchorPosition = null;
      state.anchorRotation = null;
      states.set(die.id, state);
      return;
    }
    if (
      clockMs - state.stationarySinceMs < settleDelayMs ||
      clockMs - state.lastReleasedAtMs < cooldownMs
    ) {
      states.set(die.id, state);
      return;
    }

    const nearbyWalls = walls.filter((wall) =>
      die.collider.contactCollider(wall.collider, DIE_SIZE / 2),
    );
    const blockers = dice.filter(
      (other) =>
        other !== die &&
        ((elevated &&
          other.body.translation().y < position.y - DIE_SIZE * 0.32 &&
          hasLowerSupportContact(world, die.collider, [other.collider])) ||
          (nearbyWalls.length > 0 && die.collider.contactCollider(other.collider, 0.005))),
    );
    if (blockers.length > 0) {
      const centerX =
        blockers.reduce((sum, other) => sum + other.body.translation().x, 0) / blockers.length;
      const centerZ =
        blockers.reduce((sum, other) => sum + other.body.translation().z, 0) / blockers.length;
      let dx = position.x - centerX;
      let dz = position.z - centerZ;
      // A lower support or side neighbour can pin a tilted die against a wall.
      // Escape tangentially rather than rotating or pushing back into the wedge.
      for (const wall of nearbyWalls) {
        const outward = Math.min(0, dx * wall.inwardX + dz * wall.inwardZ);
        dx -= outward * wall.inwardX;
        dz -= outward * wall.inwardZ;
      }
      if (Math.hypot(dx, dz) < 0.001) {
        dx = nearbyWalls.reduce((sum, wall) => sum + wall.inwardX, 0);
        dz = nearbyWalls.reduce((sum, wall) => sum + wall.inwardZ, 0);
        if (nearbyWalls.length === 0) dx = 1;
      }
      const length = Math.hypot(dx, dz);
      // A single support needs a half-edge slide. Bridging multiple supports
      // can require a full edge before gravity pulls the die off the bridge.
      // A low wedge rests on felt, while an elevated stack rests on another die.
      // Contacts select the direction and energy, never a face value.
      const friction = elevated
        ? die.collider.friction()
        : Math.max(die.collider.friction(), floor.friction());
      const escapeSpeed = Math.sqrt(
        friction * Math.abs(world.gravity.y) * DIE_SIZE * (elevated && blockers.length > 1 ? 2 : 1),
      );
      die.body.applyImpulse(
        {
          x: (dx / length) * die.body.mass() * escapeSpeed,
          y: 0,
          z: (dz / length) * die.body.mass() * escapeSpeed,
        },
        true,
      );
    } else {
      const torqueAxis = faceSettleTorqueAxis(
        state.targetFaceNormal ?? nearestFaceNormal(rotation),
        rotation,
      );
      if (!torqueAxis) return;
      // Rolling about this axis travels along (-axis.z, axis.x). Do not tip
      // toward an almost-touching wall and then undo it with a wall nudge.
      const blockingWalls = nearbyWalls.filter(
        (wall) =>
          die.collider.contactCollider(wall.collider, 0.02) &&
          -torqueAxis.z * wall.inwardX + torqueAxis.x * wall.inwardZ < -0.000001,
      );
      const inwardX = blockingWalls.reduce((sum, wall) => sum + wall.inwardX, 0);
      const inwardZ = blockingWalls.reduce((sum, wall) => sum + wall.inwardZ, 0);
      const inwardLength = Math.hypot(inwardX, inwardZ);
      if (inwardLength > 0) {
        // Replace the torque with the existing wall-escape energy, never both.
        die.body.applyImpulse(
          {
            x: (inwardX / inwardLength) * die.body.mass() * 0.8,
            y: 0,
            z: (inwardZ / inwardLength) * die.body.mass() * 0.8,
          },
          true,
        );
      } else {
        const torque = 0.011 * (DIE_SIZE / 0.52) ** 5;
        die.body.applyTorqueImpulse(
          { x: torqueAxis.x * torque, y: 0, z: torqueAxis.z * torque },
          true,
        );
      }
    }
    state.stationarySinceMs = null;
    state.anchorPosition = null;
    state.anchorRotation = null;
    state.lastReleasedAtMs = clockMs;
    states.set(die.id, state);
  });
}

export function releaseRestingWallLeans(
  world: World,
  dice: RestSimulationDie[],
  walls: TrayWall[],
  clockMs: number,
  releaseTimes: Map<string, number>,
): void {
  const floorContactY = FLOOR_TOP_Y + DIE_SIZE / 2;
  const wallLeanLiftThreshold = DIE_SIZE * 0.08;
  const cooldownMs = 180;

  dice.forEach((die) => {
    const position = die.body.translation();
    const lift = position.y - floorContactY;
    if (lift < wallLeanLiftThreshold) return;
    // Elevated support contacts are handled by support escape. Competing
    // wall nudges would keep restarting its stationary window.
    if (lift > DIE_SIZE * 0.32) return;
    if (topFaceAlignment(die.body.rotation()) > 0.9) return;
    const linear = die.body.linvel();
    const angular = die.body.angvel();
    if (Math.hypot(linear.x, linear.y, linear.z) >= 0.2) return;
    if (Math.hypot(angular.x, angular.y, angular.z) >= 0.6) return;

    // Predictive solver contacts persist after separation. Only a touching wall
    // can support a lean; do not keep nudging a die that has already left it.
    const contacts = walls.filter(
      (candidate) =>
        hasSolverContact(world, die.collider, candidate.collider) &&
        die.collider.contactCollider(candidate.collider, 0.005),
    );
    if (contacts.length === 0) return;
    // Ground-edge escape owns a wall-and-die wedge, including low side contacts.
    // A simultaneous wall push would drive it back into the neighbouring die.
    if (dice.some((other) => other !== die && die.collider.contactCollider(other.collider, 0.005)))
      return;
    const inwardX = contacts.reduce((sum, wall) => sum + wall.inwardX, 0);
    const inwardZ = contacts.reduce((sum, wall) => sum + wall.inwardZ, 0);
    const inwardLength = Math.hypot(inwardX, inwardZ);
    if (inwardLength === 0) return;

    const releaseKey = die.id;
    if (clockMs - (releaseTimes.get(releaseKey) ?? Number.NEGATIVE_INFINITY) < cooldownMs) return;
    releaseTimes.set(releaseKey, clockMs);

    die.body.applyImpulse(
      {
        x: (inwardX / inwardLength) * die.body.mass() * 0.8,
        y: 0,
        z: (inwardZ / inwardLength) * die.body.mass() * 0.8,
      },
      true,
    );
  });
}

export function areDicePhysicallyStable(
  dice: RestSimulationDie[],
  maxLinearSpeed = REST_LINEAR_SPEED,
  maxAngularSpeed = REST_ANGULAR_SPEED,
): boolean {
  return maxDieLinearSpeed(dice) < maxLinearSpeed && maxDieAngularSpeed(dice) < maxAngularSpeed;
}

export function areDiceReadablySettled(
  dice: RestSimulationDie[],
  maxLift: number,
  minAlignment: number,
): boolean {
  return maxDieLift(dice) < maxLift && minTopFaceAlignment(dice) > minAlignment;
}

export function hasPhysicalYStack(dice: RestSimulationDie[]): boolean {
  for (let a = 0; a < dice.length; a += 1) {
    const positionA = dice[a].body.translation();
    for (let b = a + 1; b < dice.length; b += 1) {
      const positionB = dice[b].body.translation();
      const planarDistance = Math.hypot(positionA.x - positionB.x, positionA.z - positionB.z);
      const yGap = Math.abs(positionA.y - positionB.y);
      if (planarDistance < DIE_SIZE * 1.02 && yGap > DIE_SIZE * 0.32) return true;
    }
  }
  return false;
}

function hasLowerSupportContact(world: World, die: Collider, supports: Collider[]): boolean {
  let hasLowerContact = false;

  supports.forEach((support) => {
    world.contactPair(die, support, (manifold, flipped) => {
      // A rounded edge can carry weight at or above the centre of the supported
      // die. The contact normal, not contact-point height, identifies support.
      const upwardNormal = manifold.normal().y * (flipped ? 1 : -1);
      if (upwardNormal <= 0.15) return;
      // Solver contacts also include separated, predicted collisions. Those
      // neighbours must not act as current supports or steer the escape push.
      for (let index = 0; index < manifold.numSolverContacts(); index += 1) {
        if (manifold.solverContactDist(index) <= 0.005) hasLowerContact = true;
      }
    });
  });
  return hasLowerContact;
}

function nearestFaceNormal(rotation: Rotation): VectorTuple {
  const faceNormals: VectorTuple[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  return faceNormals.reduce((best, normal) =>
    rotateVectorByQuat(normal, rotation)[1] > rotateVectorByQuat(best, rotation)[1] ? normal : best,
  );
}

function faceSettleTorqueAxis(
  localFaceNormal: VectorTuple,
  rotation: Rotation,
): Vector | undefined {
  const worldNormal = rotateVectorByQuat(localFaceNormal, rotation);
  const horizontalLength = Math.hypot(worldNormal[0], worldNormal[2]);
  if (horizontalLength < 0.01) return undefined;

  return {
    x: -worldNormal[2] / horizontalLength,
    y: 0,
    z: worldNormal[0] / horizontalLength,
  };
}

function maxDieLift(dice: RestSimulationDie[]): number {
  return Math.max(...dice.map((die) => die.body.translation().y - (FLOOR_TOP_Y + DIE_SIZE / 2)));
}

function maxDieLinearSpeed(dice: RestSimulationDie[]): number {
  return Math.max(
    ...dice.map((die) => {
      const linear = die.body.linvel();
      return Math.hypot(linear.x, linear.y, linear.z);
    }),
  );
}

function maxDieAngularSpeed(dice: RestSimulationDie[]): number {
  return Math.max(
    ...dice.map((die) => {
      const angular = die.body.angvel();
      return Math.hypot(angular.x, angular.y, angular.z);
    }),
  );
}

function minTopFaceAlignment(dice: RestSimulationDie[]): number {
  return Math.min(...dice.map((die) => topFaceAlignment(die.body.rotation())));
}
