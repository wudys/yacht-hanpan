import type { Collider, Rotation, Vector, World } from '@dimforge/rapier3d-deterministic';

import { hasLowerSupportContact, hasTouchingWallContact } from '../contact-query';
import type { PhysicsDie, TrayWall } from '../physics-environment';
import { topFaceAlignment } from '../result-recognition';
import { DIE_SIZE, FLOOR_TOP_Y } from '../roll-simulation-constants';
import {
  quatDistance,
  type QuaternionTuple,
  rotateVectorByQuat,
  type VectorTuple,
} from '../simulation-math';
import {
  POSE_POSITION_TOLERANCE,
  POSE_ROTATION_TOLERANCE,
  SLOW_ANGULAR_SPEED,
  SLOW_LINEAR_SPEED,
} from './settling-criteria';

export interface GroundEdgeReleaseState {
  stationarySinceMs: number | null;
  lastReleasedAtMs: number;
  anchorPosition: VectorTuple | null;
  anchorRotation: QuaternionTuple | null;
  targetFaceNormal: VectorTuple | null;
}

export interface AppliedSettlingAssist {
  readonly dieId: string;
  readonly simulationMs: number;
  readonly kind: 'wall' | 'side' | 'torque';
  readonly actualDelta: number;
}

export interface SettlingAssistState {
  readonly sharedReleaseTimes: Map<string, number>;
  readonly onApplied: (event: AppliedSettlingAssist) => void;
}

export interface SettlingAssistance {
  apply(simulationMs: number): void;
}

/** One candidate owns both phases' observations and local/shared reservations. */
export function createSettlingAssistance(
  world: World,
  dice: PhysicsDie[],
  floor: Collider,
  walls: TrayWall[],
  onApplied: (event: AppliedSettlingAssist) => void,
): SettlingAssistance {
  const wallReleaseTimes = new Map<string, number>();
  const groundStates = new Map<string, GroundEdgeReleaseState>();
  const assists: SettlingAssistState = { sharedReleaseTimes: new Map(), onApplied };
  return {
    apply(simulationMs) {
      releaseRestingWallLeans(world, dice, walls, simulationMs, wallReleaseTimes, assists);
      releaseRestingGroundEdges(world, dice, floor, simulationMs, groundStates, walls, assists);
    },
  };
}

export function releaseRestingGroundEdges(
  world: World,
  dice: PhysicsDie[],
  floor: Collider,
  clockMs: number,
  states: Map<string, GroundEdgeReleaseState>,
  walls: TrayWall[],
  assistState: SettlingAssistState,
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
      Math.hypot(linear.x, linear.y, linear.z) < SLOW_LINEAR_SPEED &&
      Math.hypot(angular.x, angular.y, angular.z) < SLOW_ANGULAR_SPEED &&
      Math.hypot(
        position.x - state.anchorPosition[0],
        position.y - state.anchorPosition[1],
        position.z - state.anchorPosition[2],
      ) < POSE_POSITION_TOLERANCE &&
      quatDistance(state.anchorRotation, rotationTuple) < POSE_ROTATION_TOLERANCE;
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
    const touchingWalls = nearbyWalls.filter((wall) =>
      hasTouchingWallContact(world, die.collider, wall.collider),
    );
    const blockers = dice.filter(
      (other) =>
        other !== die &&
        ((elevated &&
          other.body.translation().y < position.y - DIE_SIZE * 0.32 &&
          hasLowerSupportContact(world, die.collider, [other.collider])) ||
          (touchingWalls.length > 0 && die.collider.contactCollider(other.collider, 0.005))),
    );
    // Elevated stacks are rejected by settlement policy rather than pushed sideways.
    if (blockers.length > 0 && elevated) return;
    if (blockers.length > 0) {
      const centerX =
        blockers.reduce((sum, other) => sum + other.body.translation().x, 0) / blockers.length;
      const centerZ =
        blockers.reduce((sum, other) => sum + other.body.translation().z, 0) / blockers.length;
      let dx = position.x - centerX;
      let dz = position.z - centerZ;
      // A lower support or side neighbour can pin a tilted die against a wall.
      // Escape tangentially rather than rotating or pushing back into the wedge.
      for (const wall of touchingWalls) {
        const outward = Math.min(0, dx * wall.inwardX + dz * wall.inwardZ);
        dx -= outward * wall.inwardX;
        dz -= outward * wall.inwardZ;
      }
      if (Math.hypot(dx, dz) < 0.001) {
        dx = touchingWalls.reduce((sum, wall) => sum + wall.inwardX, 0);
        dz = touchingWalls.reduce((sum, wall) => sum + wall.inwardZ, 0);
      }
      const length = Math.hypot(dx, dz);
      // A low wall-and-die wedge receives only the missing speed along its contact direction.
      // Elevated blockers already returned; each remaining blocker is a direct
      // neighbour contact and touchingWalls is non-empty. No pose changed since observation.
      applySettlingImpulse(die, clockMs, 'side', dx / length, dz / length, 3.6, assistState);
    } else {
      const torqueAxis = faceSettleTorqueAxis(
        state.targetFaceNormal ?? nearestFaceNormal(rotation),
        rotation,
      );
      if (!torqueAxis) return;
      // Rolling about this axis travels along (-axis.z, axis.x). Do not tip
      // toward an almost-touching wall and then undo it with a wall nudge.
      const blockingWalls = touchingWalls.filter(
        (wall) => -torqueAxis.z * wall.inwardX + torqueAxis.x * wall.inwardZ < -0.000001,
      );
      const inwardX = blockingWalls.reduce((sum, wall) => sum + wall.inwardX, 0);
      const inwardZ = blockingWalls.reduce((sum, wall) => sum + wall.inwardZ, 0);
      const inwardLength = Math.hypot(inwardX, inwardZ);
      if (inwardLength > 0) {
        // Replace blocked torque with a wall escape using the same touching predicate.
        applySettlingImpulse(
          die,
          clockMs,
          'wall',
          inwardX / inwardLength,
          inwardZ / inwardLength,
          0.65,
          assistState,
        );
      } else if (reserveSharedAssist(die, clockMs, assistState)) {
        const before = die.body.angvel();
        const torque = 0.011 * (DIE_SIZE / 0.52) ** 5 * 4;
        die.body.applyTorqueImpulse(
          { x: torqueAxis.x * torque, y: 0, z: torqueAxis.z * torque },
          true,
        );
        notifyAppliedAssist(die, clockMs, 'torque', before, die.body.angvel(), assistState);
      }
    }
    // Reserve the local window even when the shared gate denied this attempt.
    state.stationarySinceMs = null;
    state.anchorPosition = null;
    state.anchorRotation = null;
    state.lastReleasedAtMs = clockMs;
    states.set(die.id, state);
  });
}

export function releaseRestingWallLeans(
  world: World,
  dice: PhysicsDie[],
  walls: TrayWall[],
  clockMs: number,
  releaseTimes: Map<string, number>,
  assistState: SettlingAssistState,
): void {
  const floorContactY = FLOOR_TOP_Y + DIE_SIZE / 2;
  const wallLeanLiftThreshold = DIE_SIZE * 0.08;
  const cooldownMs = 180;

  dice.forEach((die) => {
    const position = die.body.translation();
    const lift = position.y - floorContactY;
    if (lift < wallLeanLiftThreshold) return;
    // Elevated support stacks are left for policy rejection. Competing wall
    // nudges would keep restarting the ground observation window.
    if (lift > DIE_SIZE * 0.32) return;
    if (topFaceAlignment(die.body.rotation()) > 0.9) return;
    const linear = die.body.linvel();
    const angular = die.body.angvel();
    if (Math.hypot(linear.x, linear.y, linear.z) >= SLOW_LINEAR_SPEED) return;
    if (Math.hypot(angular.x, angular.y, angular.z) >= SLOW_ANGULAR_SPEED) return;

    // Predictive solver contacts persist after separation. Only a touching wall
    // can support a lean; do not keep nudging a die that has already left it.
    const contacts = walls.filter((candidate) =>
      hasTouchingWallContact(world, die.collider, candidate.collider),
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

    applySettlingImpulse(
      die,
      clockMs,
      'wall',
      inwardX / inwardLength,
      inwardZ / inwardLength,
      0.65,
      assistState,
    );
  });
}

function reserveSharedAssist(
  die: PhysicsDie,
  clockMs: number,
  state: SettlingAssistState,
): boolean {
  if (clockMs - (state.sharedReleaseTimes.get(die.id) ?? Number.NEGATIVE_INFINITY) < 300)
    return false;
  state.sharedReleaseTimes.set(die.id, clockMs);
  return true;
}

function applySettlingImpulse(
  die: PhysicsDie,
  clockMs: number,
  kind: 'wall' | 'side',
  directionX: number,
  directionZ: number,
  targetSpeed: number,
  state: SettlingAssistState,
): void {
  if (!reserveSharedAssist(die, clockMs, state)) return;
  const before = die.body.linvel();
  const projectedSpeed = before.x * directionX + before.z * directionZ;
  const delta = Math.max(0, targetSpeed - projectedSpeed);
  // Keep zero-impulse wake and cooldown reservation; policy counts only actual changes.
  die.body.applyImpulse(
    { x: directionX * die.body.mass() * delta, y: 0, z: directionZ * die.body.mass() * delta },
    true,
  );
  notifyAppliedAssist(die, clockMs, kind, before, die.body.linvel(), state);
}

function notifyAppliedAssist(
  die: PhysicsDie,
  simulationMs: number,
  kind: AppliedSettlingAssist['kind'],
  before: Vector,
  after: Vector,
  state: SettlingAssistState,
): void {
  state.onApplied({
    dieId: die.id,
    simulationMs,
    kind,
    actualDelta: Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z),
  });
}

export function hasReadableHandoffPose(
  dice: PhysicsDie[],
  maxLift: number,
  minAlignment: number,
): boolean {
  return maxDieLift(dice) < maxLift && minTopFaceAlignment(dice) > minAlignment;
}

export function hasElevatedNearbyPair(dice: PhysicsDie[]): boolean {
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

function maxDieLift(dice: PhysicsDie[]): number {
  return Math.max(...dice.map((die) => die.body.translation().y - (FLOOR_TOP_Y + DIE_SIZE / 2)));
}

function minTopFaceAlignment(dice: PhysicsDie[]): number {
  return Math.min(...dice.map((die) => topFaceAlignment(die.body.rotation())));
}
