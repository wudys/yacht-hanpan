import {
  createReplayDigest,
  parseSimulationInput,
  type RollCandidateEvaluation,
  type SimulationInput,
  type SimulationOutcome,
  type SimulationReplay,
  type SimulationResult,
} from '../contract';
import { simulateRollPhysics } from './simulate-physics';
import { SimulationRejectedError } from './simulation-rejected-error';

export async function evaluateRollCandidate(
  input: SimulationInput,
): Promise<RollCandidateEvaluation> {
  return simulateRollPhysics(parseSimulationInput(input), false);
}

export async function simulateRollOutcome(input: SimulationInput): Promise<SimulationOutcome> {
  const result = await evaluateRollCandidate(input);
  if (result.status === 'rejected') throw new SimulationRejectedError(result);
  return result.outcome;
}

export async function simulateRollReplay(input: SimulationInput): Promise<SimulationReplay> {
  const result = simulateRollPhysics(parseSimulationInput(input), true);
  if (result.status === 'rejected') throw new SimulationRejectedError(result);
  return result.replay;
}

export async function simulateRoll(input: SimulationInput): Promise<SimulationResult> {
  const replay = await simulateRollReplay(input);
  const replayDigest = await createReplayDigest(replay.input, replay.timeline);

  return deepFreeze({
    ...replay,
    replayDigest,
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;

  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key]);
  }
  return Object.freeze(value);
}
