import { canonicalizeReplay } from './canonicalize';
import { DICE_SIMULATION_CONTRACT } from './constants';
import type { RollTimeline, SimulationInput } from './types';

export async function createReplayDigest(
  input: SimulationInput,
  timeline: RollTimeline,
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeReplay(input, timeline));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const hexadecimal = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${DICE_SIMULATION_CONTRACT.replayDigestVersion}:${hexadecimal}`;
}
