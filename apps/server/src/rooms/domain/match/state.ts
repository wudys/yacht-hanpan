import type { SeatIndex } from '@repo/yacht-rules';

import { TURN_DURATION_MS } from '@/rooms/domain/match/constants';
import type { MatchRejectionCode } from '@/rooms/domain/match/errors';
import type {
  CreateMatchInput,
  Match,
  MatchPlayer,
  MatchTransition,
  NextTurnInput,
  PlayingMatch,
} from '@/rooms/domain/match/model';
import { epochMilliseconds } from '@/rooms/domain/time';

export function rejectTransition(match: Match, code: MatchRejectionCode): MatchTransition {
  return { ok: false, changed: false, match, code };
}

export function replacePlayer(
  players: readonly [MatchPlayer, MatchPlayer],
  seatIndex: SeatIndex,
  player: MatchPlayer,
): readonly [MatchPlayer, MatchPlayer] {
  return seatIndex === 0 ? [player, players[1]] : [players[0], player];
}

export function otherSeatIndex(seatIndex: SeatIndex): SeatIndex {
  return seatIndex === 0 ? 1 : 0;
}

export function createMatch({ initialTurn }: CreateMatchInput): PlayingMatch {
  return {
    status: 'playing',
    players: [
      { scorecard: {}, timeoutCount: 0 },
      { scorecard: {}, timeoutCount: 0 },
    ],
    currentTurn: createTurn(0, initialTurn),
  };
}

export function createTurn(
  seatIndex: SeatIndex,
  nextTurn: NextTurnInput,
): PlayingMatch['currentTurn'] {
  return {
    id: nextTurn.id,
    seatIndex,
    startedAt: nextTurn.startedAt,
    deadlineAt: epochMilliseconds(nextTurn.startedAt + TURN_DURATION_MS),
    heldSlots: [],
    diceState: { rollCount: 0, dice: null },
  };
}
