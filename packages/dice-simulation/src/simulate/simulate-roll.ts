import {
  createReplayDigest,
  parseSimulationInput,
  type SimulationInput,
  type SimulationResult,
} from '../contract';
import { simulateRollTimeline } from './simulate-timeline';

export async function simulateRoll(input: SimulationInput): Promise<SimulationResult> {
  const parsedInput = parseSimulationInput(input);
  const timeline = simulateRollTimeline(parsedInput);
  const authoritativeValuesBySlot = timeline.dice.map(({ slot, value }) => ({ slot, value }));
  const replayDigest = await createReplayDigest(parsedInput, timeline);

  return deepFreeze({
    input: parsedInput,
    timeline,
    authoritativeValuesBySlot,
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
