import type { Collider, World } from '@dimforge/rapier3d-deterministic';

import type { DieFrame, RollCandidateRejectionReason } from '../../contract';
import type { PhysicsDie } from './physics-environment';
import type { SettlingAssistance } from './physics-settling';
import { STEP, timelineSampleEverySteps } from './roll-simulation-constants';
import type { SettlementPolicy } from './settlement-policy';
import { round } from './simulation-math';

// The final rest phase requires a longer stable run than the rollout handoff.
const REST_STABLE_SAMPLES = 10;

interface PhysicsRestContinuation {
  readonly dice: PhysicsDie[];
  readonly frames?: DieFrame[][];
  readonly simulationMs: number;
  readonly policy: SettlementPolicy;
  readonly assistance: SettlingAssistance;
}

interface PhysicsRestEnvironment {
  readonly world: World;
  readonly floor: Collider;
}

export function runPhysicsRest(
  { dice, frames, simulationMs, policy, assistance }: PhysicsRestContinuation,
  { world, floor }: PhysicsRestEnvironment,
):
  | { status: 'settled'; simulationMs: number }
  | { status: 'rejected'; reason: RollCandidateRejectionReason; simulationMs: number } {
  const maxRestMs = 1500;
  const sampleEvery = timelineSampleEverySteps();
  let elapsedMs = 0;
  let step = 0;
  let stableSamples = 0;

  while (elapsedMs < maxRestMs) {
    world.step();
    step += 1;
    elapsedMs = Math.round(step * STEP * 1000);
    assistance.apply(simulationMs + elapsedMs);

    const observation = policy.observe(world, dice, floor, simulationMs + elapsedMs, true);
    if (observation.rejection) return { status: 'rejected', ...observation.rejection };
    stableSamples = observation.readable ? stableSamples + 1 : 0;
    if (elapsedMs > 100 && stableSamples >= REST_STABLE_SAMPLES) break;

    if (!frames || step % sampleEvery !== 0) continue;

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
  if (stableSamples < REST_STABLE_SAMPLES) {
    return { status: 'rejected', reason: 'unsettled-at-limit', simulationMs: finalT };
  }
  if (frames)
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

  return { status: 'settled', simulationMs: finalT };
}
