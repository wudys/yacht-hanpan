import {
  createReplayDigest,
  parseSimulationInput,
  type SimulationInput,
  type SimulationOutcome,
  type SimulationReplay,
  type SimulationResult,
} from '../contract';
import { simulateRollPhysics } from './simulate-timeline';

export async function simulateRollOutcome(input: SimulationInput): Promise<SimulationOutcome> {
  return simulateRollPhysics(parseSimulationInput(input), false);
}

export async function simulateRollReplay(input: SimulationInput): Promise<SimulationReplay> {
  return simulateRollPhysics(parseSimulationInput(input), true);
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
