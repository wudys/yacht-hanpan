import type { SeatIndex } from '@repo/yacht-rules';

import { MATCH_REJECTION_CODE } from '@/rooms/domain/match/errors';
import type { Match, MatchDecision, PlayingMatch, TurnId } from '@/rooms/domain/match/model';
import type { EpochMilliseconds } from '@/rooms/domain/time';

export interface ActiveTurnCommand {
  readonly seatIndex: SeatIndex;
  readonly turnId: TurnId;
  readonly receivedAt: EpochMilliseconds;
}

export function validateActiveTurn(
  match: Match,
  command: ActiveTurnCommand,
): MatchDecision<PlayingMatch> {
  if (match.status === 'finished') return { ok: false, code: MATCH_REJECTION_CODE.MATCH_FINISHED };
  if (match.players[command.seatIndex] === undefined) {
    return { ok: false, code: MATCH_REJECTION_CODE.INVALID_PLAYER };
  }
  if (match.currentTurn.seatIndex !== command.seatIndex) {
    return { ok: false, code: MATCH_REJECTION_CODE.NOT_YOUR_TURN };
  }
  if (match.currentTurn.id !== command.turnId) {
    return { ok: false, code: MATCH_REJECTION_CODE.STALE_TURN };
  }
  if (command.receivedAt >= match.currentTurn.deadlineAt) {
    return { ok: false, code: MATCH_REJECTION_CODE.TURN_EXPIRED };
  }
  return { ok: true, value: match };
}
