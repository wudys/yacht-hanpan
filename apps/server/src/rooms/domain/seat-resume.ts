import type { SeatIndex } from '@repo/yacht-rules';

import { evaluateTurnExpiry } from '@/rooms/domain/match/match-lifecycle';
import { resumeSeat } from '@/rooms/domain/presence';
import type { RoomRejectionCode } from '@/rooms/domain/room-constants';
import {
  isFinishedRoomState,
  isWaitingRoomState,
  type PlayingRoomState,
  type RoomState,
  type WaitingRoomState,
} from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';

export type SeatResumeDecision =
  | {
      readonly ok: true;
      readonly state: WaitingRoomState | PlayingRoomState;
      readonly presenceChanged: boolean;
    }
  | { readonly ok: false; readonly reason: 'roomRejected'; readonly code: RoomRejectionCode }
  | { readonly ok: false; readonly reason: 'terminalExpiry' };

export function evaluateSeatResume(
  current: RoomState,
  input: Readonly<{ seatIndex: SeatIndex; resumedAt: number }>,
): SeatResumeDecision {
  if (isFinishedRoomState(current)) {
    const rejected = resumeSeat(current.room, input);
    return { ok: false, reason: 'roomRejected', code: rejected.code };
  }
  if (isWaitingRoomState(current)) {
    const resumed = resumeSeat(current.room, input);
    return resumed.ok
      ? { ok: true, state: { room: resumed.room, match: null }, presenceChanged: resumed.changed }
      : { ok: false, reason: 'roomRejected', code: resumed.code };
  }

  const resumed = resumeSeat(current.room, input);
  if (!resumed.ok) return { ok: false, reason: 'roomRejected', code: resumed.code };
  if (input.resumedAt >= current.match.currentTurn.deadlineAt) {
    // Eligibility does not commit expiry or revive a terminal match when its timer is delayed.
    const timeout = evaluateTurnExpiry(current.match, {
      expectedTurnId: current.match.currentTurn.id,
      checkedAt: epochMilliseconds(input.resumedAt),
    });
    if (timeout.kind === 'finished') return { ok: false, reason: 'terminalExpiry' };
  }
  return {
    ok: true,
    state: { room: resumed.room, match: current.match },
    presenceChanged: resumed.changed,
  };
}
