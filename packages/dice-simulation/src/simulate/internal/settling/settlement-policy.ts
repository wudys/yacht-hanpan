import type { Collider, World } from '@dimforge/rapier3d-deterministic';

import { hasActualLowerSupportContact } from '../contact-query';
import type { PhysicsDie } from '../physics-environment';
import { recognizeTopFace, topFaceAlignment } from '../result-recognition';
import { DIE_SIZE, FLOOR_TOP_Y } from '../roll-simulation-constants';
import {
  normalizedQuatDistance,
  quatDistance,
  type QuaternionTuple,
  type VectorTuple,
} from '../simulation-math';
import type { AppliedSettlingAssist } from './settling-assistance';
import {
  POSE_POSITION_TOLERANCE,
  POSE_ROTATION_TOLERANCE,
  REST_ANGULAR_SPEED,
  REST_LINEAR_SPEED,
  SLOW_ANGULAR_SPEED,
  SLOW_LINEAR_SPEED,
} from './settling-criteria';

interface Pose {
  readonly position: VectorTuple;
  readonly rotation: QuaternionTuple;
}

interface DieObservation extends Pose {
  readonly face: number;
  readonly alignment: number;
  readonly floorSupported: boolean;
  readonly linearSpeed: number;
  readonly angularSpeed: number;
  readonly readable: boolean;
}

interface ReadableAnchor {
  readonly sinceMs: number;
  readonly poses: readonly DieObservation[];
}

interface StackAnchor {
  readonly key: string;
  readonly sinceMs: number;
  readonly poses: ReadonlyMap<number, Pose>;
}

interface AssistEpisode {
  firstAssistMs: number | null;
  count: number;
  recovery: { readonly sinceMs: number; readonly pose: DieObservation } | null;
}

export interface SettlementObservation {
  readonly readable: boolean;
  readonly flat: boolean;
  readonly rejection: {
    readonly reason: 'stable-stack' | 'repeated-assist';
    readonly simulationMs: number;
  } | null;
}

export interface SettlementPolicy {
  recordAssist(event: AppliedSettlingAssist): void;
  observe(
    world: World,
    dice: readonly PhysicsDie[],
    floor: Collider,
    simulationMs: number,
    active: boolean,
  ): SettlementObservation;
}

/** One candidate's readiness, support graph and unresolved assistance history. */
export function createSettlementPolicy(): SettlementPolicy {
  let readableAnchor: ReadableAnchor | null = null;
  let flatSinceMs: number | null = null;
  const stackAnchors = new Map<string, StackAnchor>();
  const assistEpisodes = new Map<string, AssistEpisode>();

  const episode = (dieId: string): AssistEpisode => {
    let current = assistEpisodes.get(dieId);
    if (!current) {
      current = { firstAssistMs: null, count: 0, recovery: null };
      assistEpisodes.set(dieId, current);
    }
    return current;
  };

  return {
    recordAssist(event) {
      // A cooldown reservation or an impulse that changes no velocity is not
      // another attempt to resolve this die's unsettled episode.
      if (event.actualDelta <= 1e-8) return;
      const current = episode(event.dieId);
      current.firstAssistMs ??= event.simulationMs;
      current.count += 1;
    },

    observe(world, dice, floor, simulationMs, active) {
      const observations = dice.map((die) => observeDie(world, die, floor));
      const allReadable = active && observations.every((current) => current.readable);
      if (!allReadable) readableAnchor = null;
      else if (
        readableAnchor === null ||
        observations.some((current, index) => {
          const anchor = readableAnchor?.poses[index];
          return !anchor || anchor.face !== current.face || poseChanged(anchor, current, false);
        })
      ) {
        readableAnchor = { sinceMs: simulationMs, poses: observations };
      }
      const readable =
        allReadable && readableAnchor !== null && simulationMs - readableAnchor.sinceMs >= 150;

      const allFlat =
        active &&
        observations.every(
          (current) =>
            current.floorSupported &&
            current.alignment > 0.98 &&
            current.linearSpeed < 0.03 &&
            current.angularSpeed < 0.12,
        );
      if (!allFlat) flatSinceMs = null;
      else flatSinceMs ??= simulationMs;
      const flat = readable && flatSinceMs !== null && simulationMs - flatSinceMs >= 150;

      const stacked = observeStacks(world, dice, observations, simulationMs, active, stackAnchors);
      let repeated = false;
      if (active) {
        dice.forEach((die, index) => {
          const current = observations[index];
          const history = episode(die.id);
          if (!current.readable) history.recovery = null;
          else {
            const { recovery } = history;
            if (
              recovery === null ||
              recovery.pose.face !== current.face ||
              poseChanged(recovery.pose, current, true)
            ) {
              history.recovery = { sinceMs: simulationMs, pose: current };
            }
            if (history.recovery && simulationMs - history.recovery.sinceMs >= 150) {
              history.firstAssistMs = null;
              history.count = 0;
            }
          }

          // Separation, the same neighbour recontacting, a changed neighbour,
          // and small motion all retain history until this die truly recovers.
          const supported =
            current.floorSupported ||
            dice.some(
              (other) => other !== die && !!die.collider.contactCollider(other.collider, 0.005),
            );
          if (
            supported &&
            current.alignment <= 0.9 &&
            current.linearSpeed < SLOW_LINEAR_SPEED &&
            current.angularSpeed < SLOW_ANGULAR_SPEED &&
            history.count >= 3 &&
            history.firstAssistMs !== null &&
            simulationMs - history.firstAssistMs >= 900
          ) {
            repeated = true;
          }
        });
      }

      return {
        readable,
        flat,
        rejection: stacked
          ? { reason: 'stable-stack', simulationMs }
          : repeated
            ? { reason: 'repeated-assist', simulationMs }
            : null,
      };
    },
  };
}

function observeDie(world: World, die: PhysicsDie, floor: Collider): DieObservation {
  const p = die.body.translation();
  const q = die.body.rotation();
  const linear = die.body.linvel();
  const angular = die.body.angvel();
  const floorSupported = hasActualLowerSupportContact(world, die.collider, floor);
  const alignment = topFaceAlignment(q);
  const linearSpeed = Math.hypot(linear.x, linear.y, linear.z);
  const angularSpeed = Math.hypot(angular.x, angular.y, angular.z);
  return {
    position: [p.x, p.y, p.z],
    rotation: [q.x, q.y, q.z, q.w],
    face: recognizeTopFace(q),
    alignment,
    floorSupported,
    linearSpeed,
    angularSpeed,
    readable:
      floorSupported &&
      p.y - (FLOOR_TOP_Y + DIE_SIZE / 2) < DIE_SIZE * 0.22 &&
      alignment > 0.9 &&
      linearSpeed < REST_LINEAR_SPEED &&
      angularSpeed < REST_ANGULAR_SPEED,
  };
}

function observeStacks(
  world: World,
  dice: readonly PhysicsDie[],
  observations: readonly DieObservation[],
  simulationMs: number,
  active: boolean,
  anchors: Map<string, StackAnchor>,
): boolean {
  const edges = dice.map((die, index) =>
    dice.flatMap((other, supportIndex) =>
      supportIndex !== index &&
      observations[supportIndex].position[1] < observations[index].position[1] - DIE_SIZE * 0.32 &&
      hasActualLowerSupportContact(world, die.collider, other.collider)
        ? [supportIndex]
        : [],
    ),
  );
  const seen = new Set<string>();
  let rejected = false;
  dice.forEach((die, index) => {
    const current = observations[index];
    if (
      !active ||
      current.floorSupported ||
      current.position[1] - (FLOOR_TOP_Y + DIE_SIZE / 2) <= DIE_SIZE * 0.32 ||
      edges[index].length === 0
    ) {
      return;
    }
    const participants = new Set<number>();
    const grounded = (participant: number): boolean => {
      participants.add(participant);
      const support = observations[participant];
      if (support.linearSpeed >= SLOW_LINEAR_SPEED || support.angularSpeed >= SLOW_ANGULAR_SPEED)
        return false;
      if (support.floorSupported) return true;
      // Strictly decreasing centre height makes these at-most-five-node
      // support paths acyclic. Every branch, rather than one branch, must land.
      return edges[participant].length > 0 && edges[participant].every(grounded);
    };
    if (!grounded(index)) return;
    const indices = [...participants].sort((a, b) => a - b);
    const key = indices
      .map(
        (participant) =>
          `${dice[participant].id}:${
            observations[participant].floorSupported
              ? 'floor'
              : edges[participant].map((support) => dice[support].id).join(',')
          }`,
      )
      .join('|');
    let anchor = anchors.get(die.id);
    if (
      !anchor ||
      anchor.key !== key ||
      indices.some((participant) => {
        const pose = anchor?.poses.get(participant);
        return !pose || poseChanged(pose, observations[participant], true);
      })
    ) {
      anchor = {
        key,
        sinceMs: simulationMs,
        poses: new Map(indices.map((participant) => [participant, observations[participant]])),
      };
      anchors.set(die.id, anchor);
    }
    seen.add(die.id);
    if (simulationMs - anchor.sinceMs >= 200) rejected = true;
  });
  for (const dieId of anchors.keys()) if (!seen.has(dieId)) anchors.delete(dieId);
  return rejected;
}

function poseChanged(first: Pose, second: Pose, normalize: boolean): boolean {
  const distance = normalize ? normalizedQuatDistance : quatDistance;
  return (
    Math.hypot(
      first.position[0] - second.position[0],
      first.position[1] - second.position[1],
      first.position[2] - second.position[2],
    ) >= POSE_POSITION_TOLERANCE ||
    distance(first.rotation, second.rotation) >= POSE_ROTATION_TOLERANCE
  );
}
