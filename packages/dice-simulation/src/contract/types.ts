import type { POUR_STYLE } from './constants';

export type PourStyle = (typeof POUR_STYLE)[keyof typeof POUR_STYLE];
export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
export type DieSlot = 0 | 1 | 2 | 3 | 4;
export type Vector3Tuple = [number, number, number];
export type QuaternionTuple = [number, number, number, number];

export type SimulationInput = Readonly<{
  rollId: string;
  seed: string;
  rolledSlots: readonly DieSlot[];
  pourStyle: PourStyle;
}>;

export type DieFrame = Readonly<{
  t: number;
  p: Vector3Tuple;
  q: QuaternionTuple;
}>;

export type DieTimeline = Readonly<{
  slot: DieSlot;
  value: DieFace;
  frames: readonly DieFrame[];
}>;

export type CupFrame = Readonly<{
  t: number;
  p: Vector3Tuple;
  q: QuaternionTuple;
  visible: boolean;
  mode: 'shake' | 'pour' | 'exit';
}>;

export type CupMotion = Readonly<{
  style: PourStyle;
  shakeAmplitude: number;
  shakeFrequency: number;
  pourAtMs: number;
  releaseAtMs: number;
  exitAtMs: number;
  stageX?: number;
  innerWidth: number;
  innerDepth: number;
  innerHeight: number;
  frames: readonly CupFrame[];
}>;

export type RollArea = Readonly<{
  width: number;
  depth: number;
  aspectRatio: number;
  centerZ?: number;
  topZ?: number;
  bottomZ?: number;
}>;

export type RollTimeline = Readonly<{
  rollId: string;
  seed: string;
  durationMs: number;
  cup: CupMotion;
  rollArea: RollArea;
  dice: readonly DieTimeline[];
}>;

export type RolledFace = Readonly<{
  slot: DieSlot;
  value: DieFace;
}>;

export type SimulationOutcome = Readonly<{
  input: SimulationInput;
  authoritativeValuesBySlot: readonly RolledFace[];
}>;

export type RollCandidateRejectionReason =
  'stable-stack' | 'repeated-assist' | 'unsettled-at-limit';

export type RollCandidateRejection = Readonly<{
  status: 'rejected';
  input: SimulationInput;
  reason: RollCandidateRejectionReason;
  simulationMs: number;
}>;

export type RollCandidateEvaluation =
  Readonly<{ status: 'accepted'; outcome: SimulationOutcome }> | RollCandidateRejection;

export type SimulationReplay = SimulationOutcome &
  Readonly<{
    timeline: RollTimeline;
  }>;

export type SimulationResult = SimulationReplay &
  Readonly<{
    replayDigest: string;
  }>;
