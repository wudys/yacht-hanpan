import { parsePublicRoom, type PublicRoom, type PublicRoomInput } from '@repo/game-protocol/state';

import { ROOM_STATUS } from '@/rooms/domain/room-constants';
import { type Room, type Seat } from '@/rooms/domain/room-model';

type ProjectedSeat = PublicRoomInput['seats'][number];

function projectSeat(seat: Seat): ProjectedSeat {
  return { profile: { ...seat.profile } };
}

function projectSeats(seats: readonly [Seat]): [ProjectedSeat];
function projectSeats(seats: readonly [Seat, Seat]): [ProjectedSeat, ProjectedSeat];
function projectSeats(seats: readonly [Seat] | readonly [Seat, Seat]): PublicRoomInput['seats'] {
  const creator = projectSeat(seats[0]);
  if (seats.length === 1) return [creator];
  return [creator, projectSeat(seats[1])];
}

export function projectPublicRoom(room: Room): PublicRoom {
  const identity = { roomId: room.id, roomCode: room.code, createdAt: room.createdAt };

  if (room.status === ROOM_STATUS.WAITING) {
    return parsePublicRoom({
      status: ROOM_STATUS.WAITING,
      ...identity,
      expiresAt: room.expiresAt,
      seats: projectSeats(room.seats),
    } satisfies PublicRoomInput);
  }
  if (room.status === ROOM_STATUS.PLAYING) {
    return parsePublicRoom({
      status: ROOM_STATUS.PLAYING,
      ...identity,
      startedAt: room.startedAt,
      seats: projectSeats(room.seats),
    } satisfies PublicRoomInput);
  }
  return parsePublicRoom({
    status: ROOM_STATUS.FINISHED,
    ...identity,
    startedAt: room.startedAt,
    finishedAt: room.finishedAt,
    seats: projectSeats(room.seats),
  } satisfies PublicRoomInput);
}
