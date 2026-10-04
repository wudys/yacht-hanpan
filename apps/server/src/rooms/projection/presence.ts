import {
  parsePresenceSnapshot,
  type PresenceSnapshot,
  type PresenceSnapshotInput,
} from '@repo/game-protocol/socket';

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

export function projectPresenceSnapshot(room: Room, presenceVersion: number): PresenceSnapshot {
  const seats: PresenceSnapshotInput['seats'] =
    room.seats.length === 1
      ? [projectSeatPresence(room.seats[0])]
      : [projectSeatPresence(room.seats[0]), projectSeatPresence(room.seats[1])];
  return parsePresenceSnapshot({
    roomId: room.id,
    presenceVersion,
    seats,
  } satisfies PresenceSnapshotInput);
}
