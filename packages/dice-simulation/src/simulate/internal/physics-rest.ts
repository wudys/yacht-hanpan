import type { Collider, World } from '@dimforge/rapier3d-deterministic';

import type { DieFrame } from '../../contract';
import type { TrayWall } from './physics-environment';
import {
  areDicePhysicallyStable,
  areDiceReadablySettled,
  type GroundEdgeReleaseState,
  hasPhysicalYStack,
  releaseRestingGroundEdges,
  releaseRestingWallLeans,
  type RestSimulationDie,
} from './physics-settling';
import { DIE_SIZE, SAMPLE_FPS, STEP } from './roll-simulation-constants';
import { round } from './simulation-math';

// The final rest phase requires a longer stable run than the rollout handoff.
const REST_STABLE_SAMPLES = 10;

interface PhysicsRestContinuation {
  readonly dice: RestSimulationDie[];
  readonly frames: DieFrame[][];
  readonly simulationMs: number;
  readonly wallReleaseTimes: Map<string, number>;
  readonly groundEdgeReleaseStates: Map<string, GroundEdgeReleaseState>;
}

interface PhysicsRestEnvironment {
  readonly world: World;
  readonly floor: Collider;
  readonly walls: TrayWall[];
}

export function appendPhysicsRestFrames(
  {
    dice,
    frames,
    simulationMs,
    wallReleaseTimes,
    groundEdgeReleaseStates,
  }: PhysicsRestContinuation,
  { world, floor, walls }: PhysicsRestEnvironment,
): number {
  const maxRestMs = dice.length >= 5 ? 900 : 600;
  const sampleEvery = Math.max(1, Math.round(1 / STEP / SAMPLE_FPS));
  let elapsedMs = 0;
  let step = 0;
  let stableSamples = 0;

  while (elapsedMs < maxRestMs) {
    world.step();
    step += 1;
    elapsedMs = Math.round(step * STEP * 1000);
    releaseRestingWallLeans(world, dice, walls, simulationMs + elapsedMs, wallReleaseTimes);
    releaseRestingGroundEdges(
      world,
      dice,
      floor,
      simulationMs + elapsedMs,
      groundEdgeReleaseStates,
      walls,
    );

    const resting =
      areDicePhysicallyStable(dice) && areDiceReadablySettled(dice, DIE_SIZE * 0.22, 0.9);
    stableSamples = resting ? stableSamples + 1 : 0;
    if (elapsedMs > 320 && stableSamples >= REST_STABLE_SAMPLES) break;
    if (
      elapsedMs > 600 &&
      areDicePhysicallyStable(dice, 0.065, 0.25) &&
      areDiceReadablySettled(dice, DIE_SIZE * 0.32, 0.88) &&
      !hasPhysicalYStack(dice)
    )
      break;

    if (step % sampleEvery !== 0) continue;

    const t = simulationMs + elapsedMs;
    dice.forEach((die, index) => {
      const p = die.body.translation();
      const q = die.body.rotation();
      frames[index].push({
        t,
        p: [round(p.x), round(p.y), round(p.z)],
        q: [round(q.x), round(q.y), round(q.z), round(q.w)],
      });
    });
  }

  const finalT = simulationMs + elapsedMs;
  dice.forEach((die, index) => {
    if (frames[index].at(-1)?.t === finalT) return;
    const p = die.body.translation();
    const q = die.body.rotation();
    frames[index].push({
      t: finalT,
      p: [round(p.x), round(p.y), round(p.z)],
      q: [round(q.x), round(q.y), round(q.z), round(q.w)],
    });
  });

  return simulationMs + elapsedMs;
}
