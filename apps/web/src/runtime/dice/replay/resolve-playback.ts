import {
  type DieFace,
  type DieSlot,
  type RollTimeline,
  simulateRoll,
  type SimulationInput,
  type SimulationResult,
} from '@repo/dice-simulation';

export type ResolvedRollPlaybackArtifact = Readonly<{
  replay: Readonly<Pick<SimulationInput, 'rollId' | 'seed' | 'rolledSlots' | 'pourStyle'>>;
  outcome: Readonly<{
    authoritativeValuesBySlot: SimulationResult['authoritativeValuesBySlot'];
  }>;
  replayDigest: string;
}>;

const PLAYBACK_FALLBACK_REASON = {
  DIGEST_MISMATCH: 'DIGEST_MISMATCH',
  OUTCOME_MISMATCH: 'OUTCOME_MISMATCH',
  SIMULATION_FAILED: 'SIMULATION_FAILED',
} as const;

export type PlaybackFallbackReason =
  (typeof PLAYBACK_FALLBACK_REASON)[keyof typeof PLAYBACK_FALLBACK_REASON];

type StaticDie = Readonly<{
  slot: DieSlot;
  value: DieFace;
}>;

type VerifiedRollPlayback = Readonly<{
  status: 'verified';
  rollId: string;
  timeline: RollTimeline;
}>;

type StaticRollFallback = Readonly<{
  status: 'static-fallback';
  rollId: string;
  reason: PlaybackFallbackReason;
  cause?: unknown;
  dice: readonly StaticDie[];
}>;

export type RollPlayback = VerifiedRollPlayback | StaticRollFallback;
type RollSimulator = (input: SimulationInput) => Promise<SimulationResult>;

function sameOutcome(
  expected: ResolvedRollPlaybackArtifact['outcome']['authoritativeValuesBySlot'],
  actual: SimulationResult['authoritativeValuesBySlot'],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every(
      (face, index) => face.slot === actual[index]?.slot && face.value === actual[index]?.value,
    )
  );
}

export async function resolveRollPlayback(
  artifact: ResolvedRollPlaybackArtifact,
  simulator: RollSimulator = simulateRoll,
): Promise<RollPlayback> {
  const simulationInput: SimulationInput = {
    rollId: artifact.replay.rollId,
    seed: artifact.replay.seed,
    rolledSlots: artifact.replay.rolledSlots,
    pourStyle: artifact.replay.pourStyle,
  };

  let result: SimulationResult;
  try {
    result = await simulator(simulationInput);
  } catch (cause) {
    return {
      status: 'static-fallback',
      rollId: artifact.replay.rollId,
      reason: PLAYBACK_FALLBACK_REASON.SIMULATION_FAILED,
      cause,
      dice: artifact.outcome.authoritativeValuesBySlot,
    };
  }

  if (result.replayDigest !== artifact.replayDigest) {
    return {
      status: 'static-fallback',
      rollId: artifact.replay.rollId,
      reason: PLAYBACK_FALLBACK_REASON.DIGEST_MISMATCH,
      dice: artifact.outcome.authoritativeValuesBySlot,
    };
  }
  if (!sameOutcome(artifact.outcome.authoritativeValuesBySlot, result.authoritativeValuesBySlot)) {
    return {
      status: 'static-fallback',
      rollId: artifact.replay.rollId,
      reason: PLAYBACK_FALLBACK_REASON.OUTCOME_MISMATCH,
      dice: artifact.outcome.authoritativeValuesBySlot,
    };
  }
  return { status: 'verified', rollId: artifact.replay.rollId, timeline: result.timeline };
}
