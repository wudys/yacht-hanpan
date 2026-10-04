import {
  type Dice,
  type DieSlot,
  isCategoryId,
  type Scorecard,
  scoreCategory,
  type SeatIndex,
  turnsUsed,
} from '@repo/yacht-rules';

import { MAX_ROLLS_PER_TURN, MAX_TURNS_PER_PLAYER } from '@/rooms/domain/match/constants';
import { MATCH_REJECTION_CODE } from '@/rooms/domain/match/errors';
import { finishScoresIfTurnsExhausted } from '@/rooms/domain/match/match-lifecycle';
import type {
  Match,
  MatchDice,
  MatchPlayer,
  MatchTransition,
  NextTurnInput,
  TurnId,
} from '@/rooms/domain/match/model';
import {
  createTurn,
  otherSeatIndex,
  rejectTransition,
  replacePlayer,
} from '@/rooms/domain/match/state';
import { validateActiveTurn } from '@/rooms/domain/match/validation';
import type { EpochMilliseconds } from '@/rooms/domain/time';

export interface SetDieHeldCommand {
  readonly seatIndex: SeatIndex;
  readonly turnId: TurnId;
  readonly receivedAt: EpochMilliseconds;
  readonly slot: number;
  readonly isHeld: boolean;
}

export interface SelectScoreCategoryCommand {
  readonly seatIndex: SeatIndex;
  readonly turnId: TurnId;
  readonly receivedAt: EpochMilliseconds;
  readonly categoryId: unknown;
  readonly nextTurn: NextTurnInput;
}

function noChange(match: Match): MatchTransition {
  return { ok: true, changed: false, match };
}

export function setDieHeld(match: Match, command: SetDieHeldCommand): MatchTransition {
  const activeTurn = validateActiveTurn(match, command);
  if (!activeTurn.ok) return rejectTransition(match, activeTurn.code);
  const activeMatch = activeTurn.value;

  const { diceState } = activeMatch.currentTurn;
  if (
    diceState.dice === null ||
    diceState.rollCount >= MAX_ROLLS_PER_TURN ||
    !Number.isInteger(command.slot) ||
    command.slot < 0 ||
    command.slot > 4
  ) {
    return rejectTransition(match, MATCH_REJECTION_CODE.HOLD_NOT_ALLOWED);
  }

  const slot = command.slot as DieSlot;
  if (activeMatch.currentTurn.heldSlots.includes(slot) === command.isHeld) return noChange(match);

  return {
    ok: true,
    changed: true,
    match: {
      ...activeMatch,
      currentTurn: {
        ...activeMatch.currentTurn,
        heldSlots: command.isHeld
          ? [...activeMatch.currentTurn.heldSlots, slot]
          : activeMatch.currentTurn.heldSlots.filter((heldSlot) => heldSlot !== slot),
      },
    },
  };
}

function diceValues(dice: MatchDice): Dice {
  return [dice[0].value, dice[1].value, dice[2].value, dice[3].value, dice[4].value];
}

export function selectScoreCategory(
  match: Match,
  command: SelectScoreCategoryCommand,
): MatchTransition {
  const activeTurn = validateActiveTurn(match, command);
  if (!activeTurn.ok) return rejectTransition(match, activeTurn.code);
  const activeMatch = activeTurn.value;
  if (!isCategoryId(command.categoryId)) {
    return rejectTransition(match, MATCH_REJECTION_CODE.INVALID_CATEGORY);
  }

  const { categoryId } = command;
  const currentPlayer = activeMatch.players[command.seatIndex];
  if (Object.hasOwn(currentPlayer.scorecard, categoryId)) {
    return rejectTransition(match, MATCH_REJECTION_CODE.CATEGORY_ALREADY_RECORDED);
  }

  const { dice } = activeMatch.currentTurn.diceState;
  if (dice === null || turnsUsed(currentPlayer) >= MAX_TURNS_PER_PLAYER) {
    return rejectTransition(match, MATCH_REJECTION_CODE.SCORE_NOT_ALLOWED);
  }

  const score = scoreCategory(categoryId, diceValues(dice));
  const scorecard: Scorecard = { ...currentPlayer.scorecard, [categoryId]: score };
  const updatedPlayer: MatchPlayer = { ...currentPlayer, scorecard };
  const players = replacePlayer(match.players, command.seatIndex, updatedPlayer);

  const finished = finishScoresIfTurnsExhausted(players);
  if (finished !== null) {
    return {
      ok: true,
      changed: true,
      match: finished,
    };
  }

  const nextSeatIndex = otherSeatIndex(command.seatIndex);
  return {
    ok: true,
    changed: true,
    match: {
      status: 'playing',
      players,
      currentTurn: createTurn(nextSeatIndex, command.nextTurn),
    },
  };
}
