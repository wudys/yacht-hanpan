import type { RoomEventTime } from '@/rooms/domain/event-time';
import { turnId } from '@/rooms/domain/match';
import {
  applyRoomDeadlineDecision,
  type DeadlineReconciliation,
  evaluateRoomDeadlines,
} from '@/rooms/domain/room-deadlines';
import type { PlayingRoomState } from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';
import type { ServerIdentity } from '@/runtime/server-identity';

export function reconcileRoomDeadlines(
  current: PlayingRoomState,
  input: {
    readonly time: RoomEventTime;
    readonly committedAt: number;
    readonly identity: Pick<ServerIdentity, 'createTurnId'>;
  },
): DeadlineReconciliation {
  const decision = evaluateRoomDeadlines(current, input.time);
  return decision.kind === 'timeout'
    ? applyRoomDeadlineDecision(current, {
        ...decision,
        committedAt: input.committedAt,
        nextTurn: {
          id: turnId(input.identity.createTurnId()),
          startedAt: epochMilliseconds(input.committedAt),
        },
      })
    : applyRoomDeadlineDecision(current, { ...decision, committedAt: input.committedAt });
}
