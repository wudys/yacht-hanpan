import {
  CUP_EXIT_HOLD_MS,
  type CupFrame,
  type DieFrame,
  parseSimulationInput,
  type RollTimeline,
  type SimulationInput,
  type SimulationOutcome,
  type SimulationReplay,
} from '../contract';
import { assertRapierReady } from '../rapier/state';
import { createCupFrame, createCupMotion, cupTransformAt } from './internal/cup-motion';
import { CUP_EXIT_TAIL_MS } from './internal/cup-motion-progress';
import { cupInteriorDimensions, DEFAULT_CUP_SPEC } from './internal/cup-spec';
import {
  applyCupPourAssist,
  areDiceOutsideCup,
  createCupShakeLid,
  createPhysicsCup,
  haveDiceClearedCup,
  removeCupShakeLid,
  removePhysicsCup,
  stepWorldWithCup,
  updatePhysicsCup,
} from './internal/physics-cup';
import { createDieInCup, createRollWorld, createTray } from './internal/physics-environment';
import { appendPhysicsRestFrames } from './internal/physics-rest';
import {
  areDicePhysicallyStable,
  areDiceReadablySettled,
  type GroundEdgeReleaseState,
  hasPhysicalYStack,
  releaseRestingGroundEdges,
  releaseRestingWallLeans,
} from './internal/physics-settling';
import { recognizeTopFace } from './internal/result-recognition';
import { createRollPhysicsConfig } from './internal/roll-physics';
import { DIE_SIZE, rollAreaMeta, SAMPLE_FPS, STEP } from './internal/roll-simulation-constants';
import {
  constrainRolloutAngularVelocity,
  constrainRolloutVelocity,
} from './internal/rollout-dynamics';
import { seededNumber } from './internal/seed-expander';
import { round } from './internal/simulation-math';

// Rollout hands off to the separate final rest phase after this stable run.
const ROLLOUT_STABLE_SAMPLES = 8;

/** Internal, opt-in audit data. Never part of the wire recipe or replay timeline. */
export type PhysicsCompletionSnapshot = Readonly<{
  simulationMs: number;
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
  return simulateRollPhysics(parseSimulationInput(input), true, inspectPhysics).timeline;
}

/** Internal core. Callers own input validation; recording never changes physics cadence. */
export function simulateRollPhysics(
  input: SimulationInput,
  recordTimeline: true,
  inspectPhysics?: (snapshot: PhysicsCompletionSnapshot) => void,
): SimulationReplay;
export function simulateRollPhysics(
  input: SimulationInput,
  recordTimeline: false,
): SimulationOutcome;
export function simulateRollPhysics(
  input: SimulationInput,
  recordTimeline: boolean,
  inspectPhysics?: (snapshot: PhysicsCompletionSnapshot) => void,
): SimulationReplay | SimulationOutcome {
  const { rollId, seed, rolledSlots, pourStyle } = input;
  assertRapierReady();
  const diceCount = rolledSlots.length;
  const physics = createRollPhysicsConfig();
  const world = createRollWorld(physics);
  try {
    const tray = createTray(world, physics);

    const cup = createCupMotion(seed, pourStyle);
    const physicsCup = createPhysicsCup(world, cupTransformAt(cup, 0), DEFAULT_CUP_SPEC);
    const shakeLid = createCupShakeLid(world, physicsCup, DEFAULT_CUP_SPEC);
    const dice = Array.from({ length: diceCount }, (_, index) =>
      createDieInCup(world, seed, index, diceCount, cup, physics),
    );
    const frames: DieFrame[][] | undefined = recordTimeline ? dice.map(() => []) : undefined;
    const cupFrames: CupFrame[] | undefined = recordTimeline ? [] : undefined;
    const rollSimulationMs = Math.round(
      3100 +
        Math.max(0, diceCount - 3) * 180 +
        seededNumber(`${seed}:roll-length`, diceCount) * 620,
    );
    let simulationMs = cup.releaseAtMs + rollSimulationMs;
    const steps = Math.ceil(simulationMs / 1000 / STEP);
    const sampleEvery = Math.max(1, Math.round(1 / STEP / SAMPLE_FPS));
    let released = false;
    const exitedDice = new Set<string>();
    let cupRemoved = false;
    let shakeLidRemoved = false;
    let rolloutStableSamples = 0;
    const wallReleaseTimes = new Map<string, number>();
    const groundedEdgeReleaseStates = new Map<string, GroundEdgeReleaseState>();
    for (let step = 0; step <= steps; step += 1) {
      const t = Math.round(step * STEP * 1000);
      // Before observation, releaseAtMs is only the waiting deadline. Do not
      // let that placeholder start the exit path and pull a blocked cup away.
      if (!released && t > cup.releaseAtMs) {
        throw new CupReleaseError(t, exitedDice.size, diceCount);
      }
      if (!shakeLidRemoved && t >= cup.pourAtMs) {
        // Open before the first pour substep; the lid never drives the pour.
        removeCupShakeLid(world, physicsCup, shakeLid);
        shakeLidRemoved = true;
      }
      if (!cupRemoved) {
        updatePhysicsCup(physicsCup, cupTransformAt(cup, t));
        if (released && t >= cup.exitAtMs) {
          removePhysicsCup(world, physicsCup);
          cupRemoved = true;
          // CCD stays active for every visible cup contact, then discrete tray
          // contacts avoid CCD motion clamping of slow resting stacks.
          dice.forEach((die) => die.body.enableCcd(false));
        }
      }

      const rollElapsedSeconds = Math.max(0, (t - cup.releaseAtMs) / 1000);
      if (cupRemoved) {
        constrainRolloutVelocity(dice, rollElapsedSeconds);
        constrainRolloutAngularVelocity(dice, rollElapsedSeconds);
      }
      if (cupRemoved) world.step();
      else stepWorldWithCup(world, physicsCup);
      if (!released) applyCupPourAssist(physicsCup, dice, cup, t, exitedDice);
      if (!released) {
        for (const die of dice) {
          if (haveDiceClearedCup(world, physicsCup, [die])) exitedDice.add(die.id);
        }
      }
      if (
        !released &&
        t >= cup.pourAtMs &&
        exitedDice.size === diceCount &&
        areDiceOutsideCup(world, physicsCup, dice)
      ) {
        released = true;
        // Each die must have crossed the mouth, but an earlier die may now be
        // below/beside the finite cup after bouncing. It need not remain in the
        // mouth's infinite half-space. Current full-shape clearance still gates exit.
        cup.releaseAtMs = t + Math.round(STEP * 1000);
        cup.exitAtMs = cup.releaseAtMs + CUP_EXIT_HOLD_MS + CUP_EXIT_TAIL_MS;
      }
      if (cupRemoved) {
        releaseRestingWallLeans(world, dice, tray.walls, t, wallReleaseTimes);
        releaseRestingGroundEdges(
          world,
          dice,
          tray.floor,
          t,
          groundedEdgeReleaseStates,
          tray.walls,
        );
      }
      if (released) {
        const rolloutSettled =
          areDicePhysicallyStable(dice) && areDiceReadablySettled(dice, DIE_SIZE * 0.22, 0.9);
        rolloutStableSamples = rolloutSettled ? rolloutStableSamples + 1 : 0;
      }

      const samplesEveryPourStep = t >= cup.pourAtMs && t < cup.releaseAtMs;
      if (!samplesEveryPourStep && step % sampleEvery !== 0 && step !== steps) continue;
      if (frames && cupFrames) {
        dice.forEach((die, index) => {
          const p = die.body.translation();
          const q = die.body.rotation();
          frames[index].push({
            t,
            p: [round(p.x), round(p.y), round(p.z)],
            q: [round(q.x), round(q.y), round(q.z), round(q.w)],
          });
        });
        cupFrames.push(createCupFrame(cup, t));
      }

      const minRolloutMs = diceCount >= 5 ? 1800 : 1400;
      const maxVisualRolloutMs = 2400;
      if (
        released &&
        t > cup.exitAtMs - CUP_EXIT_HOLD_MS + 420 &&
        ((t - cup.releaseAtMs > minRolloutMs && rolloutStableSamples >= ROLLOUT_STABLE_SAMPLES) ||
          (t - cup.releaseAtMs > maxVisualRolloutMs &&
            areDiceReadablySettled(dice, DIE_SIZE * 0.3, 0.88) &&
            !hasPhysicalYStack(dice)))
      ) {
        simulationMs = t;
        break;
      }
    }
    if (!released) {
      throw new CupReleaseError(Math.round(steps * STEP * 1000), exitedDice.size, diceCount);
    }
    simulationMs = appendPhysicsRestFrames(
      {
        dice,
        frames,
        simulationMs,
        wallReleaseTimes,
        groundEdgeReleaseStates: groundedEdgeReleaseStates,
      },
      { world, floor: tray.floor, walls: tray.walls },
    );
    const recognizedOutcomeValues = dice.map((die) => recognizeTopFace(die.body.rotation()));
    const outcome: SimulationOutcome = Object.freeze({
      input,
      authoritativeValuesBySlot: Object.freeze(
        rolledSlots.map((slot, index) =>
          Object.freeze({ slot, value: recognizedOutcomeValues[index] }),
        ),
      ),
    });
    if (!frames || !cupFrames) return outcome;
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
        style: cup.style,
        shakeAmplitude: cup.shakeAmplitude,
        shakeFrequency: cup.shakeFrequency,
        pourAtMs: cup.pourAtMs,
        releaseAtMs: cup.releaseAtMs,
        exitAtMs: cup.exitAtMs,
        stageX: cup.stageX,
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
    return { ...outcome, timeline };
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
