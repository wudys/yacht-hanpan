import type { SeatIndex } from '@repo/yacht-rules';

import { earliestReconnectDeadline } from '@/rooms/domain/reconnect-policy';
import {
  PRESENCE_STATUS,
  RECONNECT_GRACE_MS,
  ROOM_REJECTION_CODE,
  ROOM_STATUS,
} from '@/rooms/domain/room-constants';
import type {
  ConnectedPresence,
  FinishedRoom,
  PlayingRoom,
  Room,
  RoomTransition,
  SeatPresence,
  WaitingRoom,
} from '@/rooms/domain/room-model';
import { roomChanged, roomRejected, roomUnchanged } from '@/rooms/domain/room-transition-result';
import { epochMilliseconds, isValidTimestamp } from '@/rooms/domain/time';

export interface DisconnectSeatInput {
  readonly seatIndex: SeatIndex;
  readonly detectedAt: unknown;
}

export interface ResumeSeatInput {
  readonly seatIndex: SeatIndex;
  readonly resumedAt: unknown;
}

export function disconnectSeat(
  room: WaitingRoom,
  input: DisconnectSeatInput,
): RoomTransition<WaitingRoom, WaitingRoom>;
export function disconnectSeat(
  room: PlayingRoom,
  input: DisconnectSeatInput,
): RoomTransition<PlayingRoom, PlayingRoom>;
export function disconnectSeat(room: Room, input: DisconnectSeatInput): RoomTransition;
export function disconnectSeat(room: Room, input: DisconnectSeatInput): RoomTransition {
  if (!isValidTimestamp(input.detectedAt) || input.detectedAt < room.createdAt) {
    return roomRejected(room, ROOM_REJECTION_CODE.INVALID_TIMESTAMP);
  }
  if (room.status === ROOM_STATUS.FINISHED) {
    return roomRejected(room, ROOM_REJECTION_CODE.ROOM_FINISHED);
  }
  if (room.status === ROOM_STATUS.WAITING && input.detectedAt >= room.expiresAt) {
    return roomRejected(room, ROOM_REJECTION_CODE.WAITING_ROOM_EXPIRED);
  }
  if (
    room.status === ROOM_STATUS.PLAYING &&
    !isValidTimestamp(input.detectedAt + RECONNECT_GRACE_MS)
  ) {
    return roomRejected(room, ROOM_REJECTION_CODE.INVALID_TIMESTAMP);
  }

  const index = input.seatIndex;
  if (room.seats[index] === undefined) {
    return roomRejected(room, ROOM_REJECTION_CODE.SEAT_NOT_FOUND);
  }
  if (room.seats[index].presence.status === PRESENCE_STATUS.DISCONNECTED) {
    return roomUnchanged(room);
  }

  const disconnectedRoom = replacePresence(room, index, {
    status: PRESENCE_STATUS.DISCONNECTED,
    reconnectDeadlineAt:
      room.status === ROOM_STATUS.PLAYING
        ? epochMilliseconds(input.detectedAt + RECONNECT_GRACE_MS)
        : null,
  });

  return roomChanged(disconnectedRoom);
}

export function resumeSeat(
  room: WaitingRoom,
  input: ResumeSeatInput,
): RoomTransition<WaitingRoom, WaitingRoom>;
export function resumeSeat(
  room: PlayingRoom,
  input: ResumeSeatInput,
): RoomTransition<PlayingRoom, PlayingRoom>;
export function resumeSeat(
  room: FinishedRoom,
  input: ResumeSeatInput,
): Extract<RoomTransition<FinishedRoom, FinishedRoom>, { readonly ok: false }>;
export function resumeSeat(room: Room, input: ResumeSeatInput): RoomTransition;
export function resumeSeat(room: Room, input: ResumeSeatInput): RoomTransition {
  if (!isValidTimestamp(input.resumedAt) || input.resumedAt < room.createdAt) {
    return roomRejected(room, ROOM_REJECTION_CODE.INVALID_TIMESTAMP);
  }
  if (room.status === ROOM_STATUS.FINISHED) {
    return roomRejected(room, ROOM_REJECTION_CODE.ROOM_FINISHED);
  }
  if (room.status === ROOM_STATUS.WAITING && input.resumedAt >= room.expiresAt) {
    return roomRejected(room, ROOM_REJECTION_CODE.WAITING_ROOM_EXPIRED);
  }

  const index = input.seatIndex;
  if (room.seats[index] === undefined) {
    return roomRejected(room, ROOM_REJECTION_CODE.SEAT_NOT_FOUND);
  }
  const deadline = earliestReconnectDeadline(room);
  if (deadline !== null && input.resumedAt >= deadline.reconnectDeadlineAt) {
    return roomRejected(room, ROOM_REJECTION_CODE.RECONNECT_NOT_AVAILABLE);
  }
  const { presence } = room.seats[index];
  if (presence.status === PRESENCE_STATUS.CONNECTED) return roomUnchanged(room);

  const connectedPresence: ConnectedPresence = {
    status: PRESENCE_STATUS.CONNECTED,
  };

  return roomChanged(replacePresence(room, index, connectedPresence));
}

function replacePresence(
  room: WaitingRoom | PlayingRoom,
  index: number,
  presence: SeatPresence,
): WaitingRoom | PlayingRoom {
  if (room.status === ROOM_STATUS.WAITING) {
    return { ...room, seats: [{ ...room.seats[0], presence }] };
  }

  return { ...room, seats: replacePlayingPresence(room.seats, index, presence) };
}

function replacePlayingPresence(
  seats: PlayingRoom['seats'],
  index: number,
  presence: SeatPresence,
): PlayingRoom['seats'] {
  return index === 0
    ? [{ ...seats[0], presence }, seats[1]]
    : [seats[0], { ...seats[1], presence }];
}
