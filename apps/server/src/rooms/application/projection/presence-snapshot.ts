import type { PresenceSnapshotInput } from '@repo/game-protocol/state';

import { PRESENCE_STATUS } from '@/rooms/domain/room-constants';
import { type Room, type Seat } from '@/rooms/domain/room-model';

function projectSeatPresence(seat: Seat): PresenceSnapshotInput['seats'][number] {
  if (seat.presence.status === PRESENCE_STATUS.CONNECTED) {
    return { status: PRESENCE_STATUS.CONNECTED };
  }
  return {
    status: PRESENCE_STATUS.DISCONNECTED,
    reconnectDeadlineAt: seat.presence.reconnectDeadlineAt,
  };
}

export function projectPresenceSnapshotInput(
  room: Room,
  presenceVersion: number,
): PresenceSnapshotInput {
  const seats: PresenceSnapshotInput['seats'] =
    room.seats.length === 1
      ? [projectSeatPresence(room.seats[0])]
      : [projectSeatPresence(room.seats[0]), projectSeatPresence(room.seats[1])];
  return {
    roomId: room.id,
    presenceVersion,
    seats,
  } satisfies PresenceSnapshotInput;
}
