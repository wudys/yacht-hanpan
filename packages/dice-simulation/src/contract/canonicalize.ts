import { DICE_SIMULATION_CONTRACT } from './constants';
import type { CupFrame, DieFrame, RollArea, RollTimeline, SimulationInput } from './types';
import { parseSimulationInput } from './validation';

export const REPLAY_CANONICALIZATION_ERROR_CODE = {
  INVALID_NUMBER: 'INVALID_REPLAY_NUMBER',
  RECIPE_MISMATCH: 'REPLAY_RECIPE_MISMATCH',
} as const;

type ReplayCanonicalizationErrorCode =
  (typeof REPLAY_CANONICALIZATION_ERROR_CODE)[keyof typeof REPLAY_CANONICALIZATION_ERROR_CODE];

export class ReplayCanonicalizationError extends Error {
  public readonly code: ReplayCanonicalizationErrorCode;

  public constructor(code: ReplayCanonicalizationErrorCode) {
    super('Replay data cannot be canonicalized');
    this.name = 'ReplayCanonicalizationError';
    this.code = code;
  }
}

export function canonicalizeReplay(input: SimulationInput, timeline: RollTimeline): string {
  const recipe = parseSimulationInput(input);
  assertRecipeMatchesTimeline(recipe, timeline);

  const canonical = [
    [
      'versions',
      DICE_SIMULATION_CONTRACT.simulationVersion,
      DICE_SIMULATION_CONTRACT.timelineSchemaVersion,
      DICE_SIMULATION_CONTRACT.replayDigestVersion,
      DICE_SIMULATION_CONTRACT.prngVersion,
      DICE_SIMULATION_CONTRACT.physicsRuntime,
      finite(DICE_SIMULATION_CONTRACT.fixedStepSeconds),
    ],
    ['recipe', recipe.rollId, recipe.seed, recipe.pourStyle, [...recipe.rolledSlots]],
    [
      'timeline',
      finite(timeline.durationMs),
      canonicalCup(timeline),
      canonicalArea(timeline.rollArea),
      [
        'dice',
        ...timeline.dice.map((die) => [die.slot, die.value, die.frames.map(canonicalDieFrame)]),
      ],
    ],
  ];

  return JSON.stringify(canonical);
}

function assertRecipeMatchesTimeline(input: SimulationInput, timeline: RollTimeline): void {
  const timelineSlots = timeline.dice.map((die) => die.slot);
  if (
    timeline.rollId !== input.rollId ||
    timeline.seed !== input.seed ||
    timeline.cup.style !== input.pourStyle ||
    timelineSlots.length !== input.rolledSlots.length ||
    timelineSlots.some((slot, index) => slot !== input.rolledSlots[index])
  ) {
    throw new ReplayCanonicalizationError(REPLAY_CANONICALIZATION_ERROR_CODE.RECIPE_MISMATCH);
  }
}

function canonicalCup(timeline: RollTimeline): unknown[] {
  const { cup } = timeline;
  return [
    'cup',
    cup.style,
    finite(cup.shakeAmplitude),
    finite(cup.shakeFrequency),
    finite(cup.pourAtMs),
    finite(cup.releaseAtMs),
    finite(cup.exitAtMs),
    finite(cup.innerWidth),
    finite(cup.innerDepth),
    finite(cup.innerHeight),
    compact([optionalNumber('stageX', cup.stageX)]),
    cup.frames.map(canonicalCupFrame),
  ];
}

function canonicalArea(area: RollArea): unknown[] {
  return [
    'area',
    finite(area.width),
    finite(area.depth),
    finite(area.aspectRatio),
    compact([
      optionalNumber('centerZ', area.centerZ),
      optionalNumber('topZ', area.topZ),
      optionalNumber('bottomZ', area.bottomZ),
    ]),
  ];
}

function canonicalDieFrame(frame: DieFrame): unknown[] {
  return [finite(frame.t), Array.from(frame.p, finite), Array.from(frame.q, finite)];
}

function canonicalCupFrame(frame: CupFrame): unknown[] {
  return [
    finite(frame.t),
    Array.from(frame.p, finite),
    Array.from(frame.q, finite),
    frame.visible,
    frame.mode,
  ];
}

function optionalNumber(
  name: string,
  value: number | undefined,
): readonly [string, number] | undefined {
  return value === undefined ? undefined : [name, finite(value)];
}

function compact<T>(values: readonly (T | undefined)[]): T[] {
  return values.filter((value): value is T => value !== undefined);
}

function finite(value: number): number {
  if (!Number.isFinite(value)) {
    throw new ReplayCanonicalizationError(REPLAY_CANONICALIZATION_ERROR_CODE.INVALID_NUMBER);
  }
  return Math.round(value * 10_000) / 10_000;
}
