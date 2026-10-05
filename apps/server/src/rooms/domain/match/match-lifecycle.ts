import { type SeatIndex, summarizeScorecard, turnsUsed } from '@repo/yacht-rules';

import {
  MATCH_END_REASON,
  MAX_TURNS_PER_PLAYER,
  TIMEOUT_FORFEIT_LIMIT,
} from '@/rooms/domain/match/constants';
import { MATCH_REJECTION_CODE, type MatchRejectionCode } from '@/rooms/domain/match/errors';
import type {
  FinishedMatch,
  Match,
  MatchPlayer,
  MatchResult,
  MatchTransition,
  NextTurnInput,
  PlayingMatch,
  TurnId,
} from '@/rooms/domain/match/model';
import {
  createTurn,
  otherSeatIndex,
  rejectTransition,
  replacePlayer,
} from '@/rooms/domain/match/state';
import type { EpochMilliseconds } from '@/rooms/domain/time';

export interface ExpireTurnCommand {
  readonly expectedTurnId: TurnId;
  readonly checkedAt: EpochMilliseconds;
  readonly nextTurn: NextTurnInput;
}

export interface ForfeitMatchCommand {
  readonly forfeitingSeatIndex: SeatIndex;
}

export interface EndMatchForConnectionCommand {
  readonly disconnectedSeatIndex: SeatIndex;
}

function winnerForScores(players: readonly [MatchPlayer, MatchPlayer]): SeatIndex | null {
  const first = summarizeScorecard(players[0].scorecard).total;
  const second = summarizeScorecard(players[1].scorecard).total;
  if (first === second) return null;
  return first > second ? 0 : 1;
}

export function finishScoresIfTurnsExhausted(
  players: readonly [MatchPlayer, MatchPlayer],
): FinishedMatch | null {
  if (!players.every((player) => turnsUsed(player) >= MAX_TURNS_PER_PLAYER)) return null;
  return {
    status: 'finished',
    players,
    result: {
      reason: MATCH_END_REASON.SCORES_COMPLETED,
      winnerSeatIndex: winnerForScores(players),
    },
  };
}

type TimedOutPlayer = Omit<MatchPlayer, 'timeoutCount'> & {
  readonly timeoutCount: 1 | 2;
};

function incrementTimeout(player: MatchPlayer): TimedOutPlayer {
  const timeoutCount = Math.min(TIMEOUT_FORFEIT_LIMIT, player.timeoutCount + 1) as 1 | 2;
  return { ...player, timeoutCount };
}

export type TurnExpiryDecision =
  | Readonly<{ kind: 'rejected'; code: MatchRejectionCode }>
  | Readonly<{ kind: 'finished'; match: FinishedMatch }>
  | Readonly<{ kind: 'advance'; players: PlayingMatch['players']; nextSeatIndex: SeatIndex }>;

export function evaluateTurnExpiry(
  match: Match,
  command: Pick<ExpireTurnCommand, 'expectedTurnId' | 'checkedAt'>,
): TurnExpiryDecision {
  if (match.status === 'finished') {
    return { kind: 'rejected', code: MATCH_REJECTION_CODE.MATCH_FINISHED };
  }
  if (match.currentTurn.id !== command.expectedTurnId) {
    return { kind: 'rejected', code: MATCH_REJECTION_CODE.STALE_TURN };
  }
  if (command.checkedAt < match.currentTurn.deadlineAt) {
    return { kind: 'rejected', code: MATCH_REJECTION_CODE.TURN_NOT_EXPIRED };
  }

  const expiredPlayer = match.players[match.currentTurn.seatIndex];
  if (expiredPlayer === undefined) {
    return { kind: 'rejected', code: MATCH_REJECTION_CODE.INVALID_PLAYER };
  }
  const updatedPlayer = incrementTimeout(expiredPlayer);
  const players = replacePlayer(match.players, match.currentTurn.seatIndex, updatedPlayer);

  // Timeout forfeits take priority over normal completion on the same expired turn.
  if (updatedPlayer.timeoutCount >= TIMEOUT_FORFEIT_LIMIT) {
    const result: MatchResult = {
      reason: MATCH_END_REASON.TIMEOUT_LIMIT,
      winnerSeatIndex: otherSeatIndex(match.currentTurn.seatIndex),
    };
    return {
      kind: 'finished',
      match: { status: 'finished', players, result },
    };
  }

  const finished = finishScoresIfTurnsExhausted(players);
  if (finished !== null) {
    return {
      kind: 'finished',
      match: finished,
    };
  }

  return { kind: 'advance', players, nextSeatIndex: otherSeatIndex(match.currentTurn.seatIndex) };
}

export function expireTurn(match: Match, command: ExpireTurnCommand): MatchTransition {
  return applyTurnExpiryDecision(match, evaluateTurnExpiry(match, command), command.nextTurn);
}

export function applyTurnExpiryDecision(
  match: Match,
  decision: TurnExpiryDecision,
  nextTurn: NextTurnInput,
): MatchTransition {
  if (decision.kind === 'rejected') return rejectTransition(match, decision.code);
  if (decision.kind === 'finished') return { ok: true, changed: true, match: decision.match };
  return {
    ok: true,
    changed: true,
    match: {
      status: 'playing',
      players: decision.players,
      currentTurn: createTurn(decision.nextSeatIndex, nextTurn),
    },
  };
}

export function forfeitMatch(match: Match, command: ForfeitMatchCommand): MatchTransition {
  return finishMatchByLoss(match, command.forfeitingSeatIndex, MATCH_END_REASON.EXPLICIT_FORFEIT);
}

export function endMatchForConnection(
  match: Match,
  command: EndMatchForConnectionCommand,
): MatchTransition {
  return finishMatchByLoss(match, command.disconnectedSeatIndex, MATCH_END_REASON.CONNECTION_ENDED);
}

function finishMatchByLoss(
  match: Match,
  losingSeatIndex: SeatIndex,
  reason: typeof MATCH_END_REASON.EXPLICIT_FORFEIT | typeof MATCH_END_REASON.CONNECTION_ENDED,
): MatchTransition {
  if (match.status === 'finished') {
    return rejectTransition(match, MATCH_REJECTION_CODE.MATCH_FINISHED);
  }
  if (match.players[losingSeatIndex] === undefined) {
    return rejectTransition(match, MATCH_REJECTION_CODE.INVALID_PLAYER);
  }

  const result: MatchResult = {
    reason,
    winnerSeatIndex: otherSeatIndex(losingSeatIndex),
  };
  return {
    ok: true,
    changed: true,
    match: { status: 'finished', players: match.players, result },
  };
}
