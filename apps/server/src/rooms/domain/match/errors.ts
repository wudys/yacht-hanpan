import type { Match } from '@/rooms/domain/match/model';

export const MATCH_REJECTION_CODE = {
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  STALE_TURN: 'STALE_TURN',
  TURN_EXPIRED: 'TURN_EXPIRED',
  TURN_NOT_STARTED: 'TURN_NOT_STARTED',
  TURN_NOT_EXPIRED: 'TURN_NOT_EXPIRED',
  ROLL_LIMIT_REACHED: 'ROLL_LIMIT_REACHED',
  NO_DICE_TO_ROLL: 'NO_DICE_TO_ROLL',
  HOLD_NOT_ALLOWED: 'HOLD_NOT_ALLOWED',
  SCORE_NOT_ALLOWED: 'SCORE_NOT_ALLOWED',
  CATEGORY_ALREADY_RECORDED: 'CATEGORY_ALREADY_RECORDED',
  INVALID_CATEGORY: 'INVALID_CATEGORY',
  INVALID_PLAYER: 'INVALID_PLAYER',
  MATCH_FINISHED: 'MATCH_FINISHED',
} as const;

export type MatchRejectionCode = (typeof MATCH_REJECTION_CODE)[keyof typeof MATCH_REJECTION_CODE];

export interface RollApplicationFailure {
  readonly ok: false;
  readonly changed: false;
  readonly match: Match;
  readonly reason: 'matchNotPlaying' | 'planMismatch' | 'invalidResult';
}
