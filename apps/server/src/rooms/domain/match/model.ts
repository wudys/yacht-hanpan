import type { DieFace, DieSlot, Scorecard, SeatIndex } from '@repo/yacht-rules';

import { MATCH_END_REASON } from '@/rooms/domain/match/constants';
import type { MatchRejectionCode } from '@/rooms/domain/match/errors';
import type { EpochMilliseconds } from '@/rooms/domain/time';

type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type TurnId = Brand<string, 'TurnId'>;

export interface MatchDie {
  readonly value: DieFace;
}

export type MatchDice = readonly [MatchDie, MatchDie, MatchDie, MatchDie, MatchDie];

export interface MatchTurn {
  readonly id: TurnId;
  readonly seatIndex: SeatIndex;
  readonly startedAt: EpochMilliseconds;
  readonly deadlineAt: EpochMilliseconds;
  readonly heldSlots: readonly DieSlot[];
  readonly diceState:
    | { readonly rollCount: 0; readonly dice: null }
    | {
        readonly rollCount: 1 | 2 | 3;
        readonly dice: MatchDice;
      };
}

export interface MatchPlayer {
  readonly scorecard: Scorecard;
  readonly timeoutCount: 0 | 1 | 2;
}

export type MatchResult =
  | {
      readonly reason: typeof MATCH_END_REASON.SCORES_COMPLETED;
      readonly winnerSeatIndex: SeatIndex | null;
    }
  | {
      readonly reason:
        | typeof MATCH_END_REASON.EXPLICIT_FORFEIT
        | typeof MATCH_END_REASON.TIMEOUT_LIMIT
        | typeof MATCH_END_REASON.CONNECTION_ENDED;
      readonly winnerSeatIndex: SeatIndex;
    };

export interface PlayingMatch {
  readonly status: 'playing';
  readonly players: readonly [MatchPlayer, MatchPlayer];
  readonly currentTurn: MatchTurn;
}

export interface FinishedMatch {
  readonly status: 'finished';
  readonly players: readonly [MatchPlayer, MatchPlayer];
  readonly result: MatchResult;
}

export type Match = PlayingMatch | FinishedMatch;

export interface NextTurnInput {
  readonly id: TurnId;
  readonly startedAt: EpochMilliseconds;
}

export interface CreateMatchInput {
  readonly initialTurn: NextTurnInput;
}

export type MatchDecision<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly code: MatchRejectionCode };

export type MatchTransition =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly match: Match;
    }
  | {
      readonly ok: false;
      readonly changed: false;
      readonly match: Match;
      readonly code: MatchRejectionCode;
    };

export function turnId(value: string): TurnId {
  if (value.length === 0) throw new Error('TurnId must not be empty');
  return value as TurnId;
}
