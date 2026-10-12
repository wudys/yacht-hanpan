import {
  CUP_EXIT_HOLD_MS,
  type CupFrame,
  DEFAULT_CUP_GEOMETRY,
  type DieFrame,
  parseSimulationInput,
  type RollCandidateEvaluation,
  type RollCandidateRejection,
  type RollTimeline,
  type SimulationInput,
  type SimulationOutcome,
  type SimulationReplay,
} from '../contract';
import { assertRapierReady } from '../rapier/state';
import {
  createCupFrame,
  createCupMotion,
  cupTransformAt,
  setCupReleaseTime,
} from './internal/cup/cup-motion';
import { cupInteriorDimensions } from './internal/cup/cup-timeline-dimensions';
import {
  applyCupPourAssist,
  applyDieExitImpulse,
  areDiceOutsideCup,
  createCupShakeLid,
  createPhysicsCup,
  haveDiceClearedCupMouth,
  removeCupShakeLid,
  removePhysicsCup,
  stepWorldWithCup,
  updatePhysicsCup,
} from './internal/cup/physics-cup';
import { createRollPhysicsConfig } from './internal/physics-config';
import { createDiceInCup, createRollWorld, createTray } from './internal/physics-environment';
import { recognizeTopFace } from './internal/result-recognition';
import {
  DIE_SIZE,
  FIXED_STEP_SECONDS,
  rollAreaMeta,
  timelineSampleEverySteps,
} from './internal/roll-simulation-constants';
import {
  constrainRolloutAngularVelocity,
  constrainRolloutVelocity,
} from './internal/rollout-dynamics';
import { seededNumber } from './internal/seed-expander';
import { runPhysicsRest } from './internal/settling/physics-rest';
import { createSettlementPolicy } from './internal/settling/settlement-policy';
import {
  createSettlingAssistance,
  hasElevatedNearbyPair,
  hasReadableHandoffPose,
} from './internal/settling/settling-assistance';
import { round } from './internal/simulation-math';
import { SimulationRejectedError } from './simulation-rejected-error';

// Rollout hands off to the separate final rest phase after this stable run.
const ROLLOUT_STABLE_SAMPLES = 8;
const ROLLOUT_HANDOFF_EVERY_STEPS = 2;

/** Internal, opt-in audit data. Never part of the wire recipe or replay timeline. */
export type PhysicsCompletionSnapshot = Readonly<{
  simulationMs: number;
  rejection?: Readonly<{ reason: RollCandidateRejection['reason'] }>;
  dice: readonly Readonly<{
    slot: SimulationInput['rolledSlots'][number];
    frameIndex: number;
    p: DieFrame['p'];
    q: DieFrame['q'];
    linearSpeed: number;
    angularSpeed: number;
  }>[];
}>;

/** Internal failure context for offline audits; not exported by the public simulator API. */
export class CupReleaseError extends Error {
  public readonly diagnostics;

  public constructor(simulationMs: number, clearedDice: number, totalDice: number) {
    super('Cup did not empty through its mouth');
    this.diagnostics = { phase: 'cup-release' as const, simulationMs, clearedDice, totalDice };
  }
}

export function simulateRollTimeline(
  input: SimulationInput,
  inspectPhysics?: (snapshot: PhysicsCompletionSnapshot) => void,
): RollTimeline {
  const result = simulateRollPhysics(parseSimulationInput(input), true, inspectPhysics);
  if (result.status === 'rejected') throw new SimulationRejectedError(result);
  return result.replay.timeline;
}

/** Internal core. Callers own input validation; recording never changes physics cadence. */
export function simulateRollPhysics(
  input: SimulationInput,
  recordTimeline: true,
  inspectPhysics?: (snapshot: PhysicsCompletionSnapshot) => void,
): { status: 'accepted'; replay: SimulationReplay } | RollCandidateRejection;
export function simulateRollPhysics(
  input: SimulationInput,
  recordTimeline: false,
): RollCandidateEvaluation;
export function simulateRollPhysics(
  input: SimulationInput,
  recordTimeline: boolean,
  inspectPhysics?: (snapshot: PhysicsCompletionSnapshot) => void,
): RollCandidateEvaluation | { status: 'accepted'; replay: SimulationReplay } {
  const { rollId, seed, rolledSlots, pourStyle } = input;
  assertRapierReady();
  const diceCount = rolledSlots.length;
  const physics = createRollPhysicsConfig();
  const world = createRollWorld(physics);
  try {
    const tray = createTray(world, physics);

    const cupMotion = createCupMotion(seed, pourStyle);
    const physicsCup = createPhysicsCup(world, cupTransformAt(cupMotion, 0), DEFAULT_CUP_GEOMETRY);
    const shakeLid = createCupShakeLid(world, physicsCup);
    const dice = createDiceInCup(world, seed, diceCount, cupMotion, physics);
    const frames: DieFrame[][] | undefined = recordTimeline ? dice.map(() => []) : undefined;
    const cupFrames: CupFrame[] | undefined = recordTimeline ? [] : undefined;
    const rollSimulationMs = Math.round(
      3100 +
        Math.max(0, diceCount - 3) * 180 +
        seededNumber(`${seed}:roll-length`, diceCount) * 620,
    );
    let simulationMs = cupMotion.releaseAtMs + rollSimulationMs;
    const steps = Math.ceil(simulationMs / 1000 / FIXED_STEP_SECONDS);
    const sampleEvery = timelineSampleEverySteps();
    let cupEmptied = false;
    // Historical mouth clearance survives later bounces below or beside the cup.
    const clearedDieIds = new Set<string>();
    let cupRemoved = false;
    let shakeLidRemoved = false;
    let rolloutStableSamples = 0;
    const policy = createSettlementPolicy();
    const assistance = createSettlingAssistance(world, dice, tray.floor, tray.walls, (event) =>
      policy.recordAssist(event),
    );
    const reject = (
      rejection: Omit<RollCandidateRejection, 'status' | 'input'>,
    ): RollCandidateRejection => {
      inspectPhysics?.({
        simulationMs: rejection.simulationMs,
        rejection: { reason: rejection.reason },
        dice: dice.map((die, index) => {
          const p = die.body.translation();
          const q = die.body.rotation();
          const linear = die.body.linvel();
          const angular = die.body.angvel();
          return {
            slot: rolledSlots[index],
            frameIndex: (frames?.[index].length ?? 0) - 1,
            p: [p.x, p.y, p.z],
            q: [q.x, q.y, q.z, q.w],
            linearSpeed: Math.hypot(linear.x, linear.y, linear.z),
            angularSpeed: Math.hypot(angular.x, angular.y, angular.z),
          };
        }),
      });
      return Object.freeze({
        status: 'rejected',
        input,
        reason: rejection.reason,
        simulationMs: rejection.simulationMs,
      });
    };
    for (let step = 0; step <= steps; step += 1) {
      const t = Math.round(step * FIXED_STEP_SECONDS * 1000);
      // Before observation, releaseAtMs is only the waiting deadline. Do not
      // let that placeholder start the exit path and pull a blocked cup away.
      if (!cupEmptied && t > cupMotion.releaseAtMs) {
        throw new CupReleaseError(t, clearedDieIds.size, diceCount);
      }
      if (!shakeLidRemoved && t >= cupMotion.pourAtMs) {
        // Open before the first pour substep; the lid never drives the pour.
        removeCupShakeLid(world, physicsCup, shakeLid);
        shakeLidRemoved = true;
      }
      if (!cupRemoved) {
        updatePhysicsCup(physicsCup, cupTransformAt(cupMotion, t));
        if (cupEmptied && t >= cupMotion.exitAtMs) {
          removePhysicsCup(world, physicsCup);
          cupRemoved = true;
          // CCD stays active for every visible cup contact, then discrete tray
          // contacts avoid CCD motion clamping of slow resting stacks.
          dice.forEach((die) => die.body.enableCcd(false));
        }
      }

      const rollElapsedSeconds = Math.max(0, (t - cupMotion.releaseAtMs) / 1000);
      if (cupRemoved) {
        constrainRolloutVelocity(dice, rollElapsedSeconds);
        constrainRolloutAngularVelocity(dice, rollElapsedSeconds);
      }
      if (cupRemoved) world.step();
      else stepWorldWithCup(world, physicsCup);
      if (!cupEmptied) applyCupPourAssist(physicsCup, dice, cupMotion, t, clearedDieIds);
      // The shake lid contains every die until pouring opens the mouth.
      if (!cupEmptied && shakeLidRemoved) {
        for (const die of dice) {
          if (!clearedDieIds.has(die.id) && haveDiceClearedCupMouth(physicsCup, [die])) {
            clearedDieIds.add(die.id);
            applyDieExitImpulse(die, cupMotion, diceCount);
          }
        }
      }
      if (
        !cupEmptied &&
        t >= cupMotion.pourAtMs &&
        clearedDieIds.size === diceCount &&
        areDiceOutsideCup(physicsCup, dice)
      ) {
        cupEmptied = true;
        // Each die must have crossed the mouth, but an earlier die may now be
        // below/beside the finite cup after bouncing. It need not remain in the
        // mouth's infinite half-space. Current full-shape clearance still gates exit.
        setCupReleaseTime(cupMotion, t + Math.round(FIXED_STEP_SECONDS * 1000));
      }
      if (cupRemoved) assistance.apply(t);
      const observation = policy.observe(world, dice, tray.floor, t, cupRemoved);
      if (observation.rejection) return reject(observation.rejection);
      rolloutStableSamples = observation.readable ? rolloutStableSamples + 1 : 0;

      const samplesEveryPourStep = t >= cupMotion.pourAtMs && t < cupMotion.releaseAtMs;
      const recordsStep = samplesEveryPourStep || step % sampleEvery === 0 || step === steps;
      if (frames && cupFrames && recordsStep) {
        dice.forEach((die, index) => {
          const p = die.body.translation();
          const q = die.body.rotation();
          frames[index].push({
            t,
            p: [round(p.x), round(p.y), round(p.z)],
            q: [round(q.x), round(q.y), round(q.z), round(q.w)],
          });
        });
        cupFrames.push(createCupFrame(cupMotion, t));
      }

      if (!samplesEveryPourStep && step % ROLLOUT_HANDOFF_EVERY_STEPS !== 0 && step !== steps)
        continue;

      const cupExitReady = cupEmptied && t > cupMotion.exitAtMs - CUP_EXIT_HOLD_MS + 420;
      if (!cupExitReady) continue;

      const rolloutElapsedMs = t - cupMotion.releaseAtMs;
      const flatHandoffReady =
        cupRemoved && rolloutElapsedMs > (diceCount >= 5 ? 1400 : 1100) && observation.flat;
      const minRolloutMs = diceCount >= 5 ? 1800 : 1400;
      const stableHandoffReady =
        rolloutElapsedMs > minRolloutMs && rolloutStableSamples >= ROLLOUT_STABLE_SAMPLES;
      const maxVisualRolloutMs = 2400;
      // Query the relaxed pose only when neither normal handoff condition is ready.
      const fallbackHandoffReady =
        !flatHandoffReady &&
        !stableHandoffReady &&
        rolloutElapsedMs > maxVisualRolloutMs &&
        hasReadableHandoffPose(dice, DIE_SIZE * 0.3, 0.88) &&
        !hasElevatedNearbyPair(dice);
      if (flatHandoffReady || stableHandoffReady || fallbackHandoffReady) {
        simulationMs = t;
        break;
      }
    }
    if (!cupEmptied) {
      throw new CupReleaseError(
        Math.round(steps * FIXED_STEP_SECONDS * 1000),
        clearedDieIds.size,
        diceCount,
      );
    }
    const rest = runPhysicsRest(
      {
        dice,
        frames,
        simulationMs,
        policy,
        assistance,
      },
      { world, floor: tray.floor },
    );
    if (rest.status === 'rejected') return reject(rest);
    simulationMs = rest.simulationMs;
    const recognizedOutcomeValues = dice.map((die) => recognizeTopFace(die.body.rotation()));
    const outcome: SimulationOutcome = Object.freeze({
      input,
      authoritativeValuesBySlot: Object.freeze(
        rolledSlots.map((slot, index) =>
          Object.freeze({ slot, value: recognizedOutcomeValues[index] }),
        ),
      ),
    });
    if (!frames || !cupFrames) return Object.freeze({ status: 'accepted', outcome });
    if (inspectPhysics) {
      inspectPhysics({
        simulationMs,
        dice: dice.map((die, index) => {
          const frameIndex = frames[index].length - 1;
          const { p, q } = frames[index][frameIndex];
          const linear = die.body.linvel();
          const angular = die.body.angvel();
          return {
            slot: rolledSlots[index],
            frameIndex,
            p: [...p],
            q: [...q],
            linearSpeed: Math.hypot(linear.x, linear.y, linear.z),
            angularSpeed: Math.hypot(angular.x, angular.y, angular.z),
          };
        }),
      });
    }
    appendPhysicalResultHold(frames);
    const durationMs = Math.max(
      cupFrames.at(-1)?.t ?? 0,
      ...frames.map((dieFrames) => dieFrames.at(-1)?.t ?? 0),
    );

    const timeline: RollTimeline = {
      rollId,
      seed,
      durationMs,
      cup: {
        style: cupMotion.style,
        shakeAmplitude: cupMotion.shakeAmplitude,
        shakeFrequency: cupMotion.shakeFrequency,
        pourAtMs: cupMotion.pourAtMs,
        releaseAtMs: cupMotion.releaseAtMs,
        exitAtMs: cupMotion.exitAtMs,
        stageX: cupMotion.stageX,
        ...cupInteriorDimensions(),
        frames: cupFrames,
      },
      rollArea: rollAreaMeta(),
      dice: rolledSlots.map((slot, index) => ({
        slot,
        value: recognizedOutcomeValues[index],
        frames: frames[index],
      })),
    };
    return { status: 'accepted', replay: { ...outcome, timeline } };
  } finally {
    world.free();
  }
}

// Keep the actual physical result visible before the presentation arranges it.
// This hold must never flatten, rotate, unstack, or relocate a die.
function appendPhysicalResultHold(frames: DieFrame[][]): void {
  for (const dieFrames of frames) {
    const last = dieFrames.at(-1)!;
    dieFrames.push({ t: last.t + 250, p: [...last.p], q: [...last.q] });
  }
}
