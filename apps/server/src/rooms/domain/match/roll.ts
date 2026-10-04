import { type DieFace, type DieSlot, isDieFace, type SeatIndex } from '@repo/yacht-rules';

import { MAX_ROLLS_PER_TURN } from '@/rooms/domain/match/constants';
import {
  MATCH_REJECTION_CODE,
  type MatchRejectionCode,
  type RollApplicationFailure,
} from '@/rooms/domain/match/errors';
import type {
  Match,
  MatchDecision,
  MatchDice,
  MatchDie,
  PlayingMatch,
  TurnId,
} from '@/rooms/domain/match/model';
import { validateActiveTurn } from '@/rooms/domain/match/validation';
import type { EpochMilliseconds } from '@/rooms/domain/time';

const ALL_SLOTS = [0, 1, 2, 3, 4] as const;

export interface PlanRollCommand {
  readonly seatIndex: SeatIndex;
  readonly turnId: TurnId;
  readonly receivedAt: EpochMilliseconds;
}

export interface RollPlan {
  readonly turnId: TurnId;
  readonly seatIndex: SeatIndex;
  readonly rollCountBefore: 0 | 1 | 2;
  readonly rollingSlots: readonly DieSlot[];
}

export interface RollFaceBySlot {
  readonly slot: DieSlot;
  readonly value: DieFace;
}

export interface ApplyRollResultInput {
  readonly plan: RollPlan;
  readonly facesBySlot: readonly RollFaceBySlot[];
}

export type RollApplicationResult =
  | { readonly ok: true; readonly changed: true; readonly match: PlayingMatch }
  | RollApplicationFailure;

function rejectDecision<Value>(code: MatchRejectionCode): MatchDecision<Value> {
  return { ok: false, code };
}

function sameSlots(left: readonly DieSlot[], right: readonly DieSlot[]): boolean {
  return left.length === right.length && left.every((slot, index) => slot === right[index]);
}

function rollingSlots(match: PlayingMatch): readonly DieSlot[] {
  const { diceState } = match.currentTurn;
  const { dice } = diceState;
  if (dice === null) return ALL_SLOTS;
  return ALL_SLOTS.filter((slot) => !match.currentTurn.heldSlots.includes(slot));
}

export function planRoll(match: Match, command: PlanRollCommand): MatchDecision<RollPlan> {
  const activeTurn = validateActiveTurn(match, command);
  if (!activeTurn.ok) return activeTurn;
  const activeMatch = activeTurn.value;

  const { rollCount } = activeMatch.currentTurn.diceState;
  if (rollCount >= MAX_ROLLS_PER_TURN) {
    return rejectDecision(MATCH_REJECTION_CODE.ROLL_LIMIT_REACHED);
  }

  const slots = rollingSlots(activeMatch);
  if (slots.length === 0) {
    return rejectDecision(MATCH_REJECTION_CODE.NO_DICE_TO_ROLL);
  }

  const rollCountBefore = rollCount as 0 | 1 | 2;
  return {
    ok: true,
    value: {
      turnId: command.turnId,
      seatIndex: command.seatIndex,
      rollCountBefore,
      rollingSlots: slots,
    },
  };
}

function nextRollNumber(rollCountBefore: RollPlan['rollCountBefore']): 1 | 2 | 3 {
  if (rollCountBefore === 0) return 1;
  if (rollCountBefore === 1) return 2;
  return 3;
}

function validatedFaces(
  expectedSlots: readonly DieSlot[],
  facesBySlot: readonly RollFaceBySlot[],
): ReadonlyMap<DieSlot, DieFace> | null {
  if (facesBySlot.length !== expectedSlots.length) return null;

  const result = new Map<DieSlot, DieFace>();
  for (const entry of facesBySlot) {
    if (!ALL_SLOTS.includes(entry.slot) || !isDieFace(entry.value)) return null;
    if (!expectedSlots.includes(entry.slot) || result.has(entry.slot)) return null;
    result.set(entry.slot, entry.value);
  }

  return result;
}

function firstRollDice(faces: ReadonlyMap<DieSlot, DieFace>): MatchDice {
  const die = (slot: DieSlot): MatchDie => ({
    value: requiredFace(faces, slot),
  });
  return [die(0), die(1), die(2), die(3), die(4)];
}

function requiredFace(faces: ReadonlyMap<DieSlot, DieFace>, slot: DieSlot): DieFace {
  const face = faces.get(slot);
  if (face === undefined) throw new Error('Validated roll result is missing a die face');
  return face;
}

function applyFaces(dice: MatchDice, faces: ReadonlyMap<DieSlot, DieFace>): MatchDice {
  const update = (slot: DieSlot, die: MatchDie): MatchDie => ({
    ...die,
    value: faces.get(slot) ?? die.value,
  });
  return [
    update(0, dice[0]),
    update(1, dice[1]),
    update(2, dice[2]),
    update(3, dice[3]),
    update(4, dice[4]),
  ];
}

export function applyRollResult(
  match: Match,
  { plan, facesBySlot }: ApplyRollResultInput,
): RollApplicationResult {
  if (match.status === 'finished') {
    return { ok: false, changed: false, match, reason: 'matchNotPlaying' };
  }

  const { currentTurn } = match;
  if (
    currentTurn.id !== plan.turnId ||
    currentTurn.seatIndex !== plan.seatIndex ||
    currentTurn.diceState.rollCount !== plan.rollCountBefore ||
    !sameSlots(rollingSlots(match), plan.rollingSlots)
  ) {
    return { ok: false, changed: false, match, reason: 'planMismatch' };
  }

  const faces = validatedFaces(plan.rollingSlots, facesBySlot);
  if (faces === null) {
    return { ok: false, changed: false, match, reason: 'invalidResult' };
  }

  const previousDice = currentTurn.diceState.dice;
  const dice = previousDice === null ? firstRollDice(faces) : applyFaces(previousDice, faces);
  const rollNumber = nextRollNumber(plan.rollCountBefore);

  return {
    ok: true,
    changed: true,
    match: {
      ...match,
      currentTurn: {
        ...currentTurn,
        diceState: { rollCount: rollNumber, dice },
      },
    },
  };
}
