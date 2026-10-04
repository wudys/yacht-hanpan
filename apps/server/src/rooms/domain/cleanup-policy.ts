import {
  ROOM_CLEANUP_REASON,
  ROOM_REJECTION_CODE,
  ROOM_STATUS,
} from '@/rooms/domain/room-constants';
import { type Room } from '@/rooms/domain/room-model';
import { isTrustedTimestamp } from '@/rooms/domain/room-validation';

export interface EvaluateCleanupInput {
  readonly checkedAt: unknown;
}

type CleanupEvaluation =
  | {
      readonly ok: true;
      readonly reason: (typeof ROOM_CLEANUP_REASON)[keyof typeof ROOM_CLEANUP_REASON] | null;
    }
  | { readonly ok: false; readonly code: typeof ROOM_REJECTION_CODE.INVALID_TIMESTAMP };

export function evaluateCleanup(room: Room, input: EvaluateCleanupInput): CleanupEvaluation {
  if (!isTrustedTimestamp(input.checkedAt)) {
    return { ok: false, code: ROOM_REJECTION_CODE.INVALID_TIMESTAMP };
  }
  if (room.status === ROOM_STATUS.WAITING) {
    return {
      ok: true,
      reason: input.checkedAt >= room.expiresAt ? ROOM_CLEANUP_REASON.WAITING_EXPIRED : null,
    };
  }
  if (room.status === ROOM_STATUS.PLAYING) {
    return { ok: true, reason: null };
  }
  if (input.checkedAt < room.finishedAt) {
    return { ok: false, code: ROOM_REJECTION_CODE.INVALID_TIMESTAMP };
  }
  return { ok: true, reason: ROOM_CLEANUP_REASON.GAME_FINISHED };
}
