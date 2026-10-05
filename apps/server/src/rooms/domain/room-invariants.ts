import { isCharacterId } from '@repo/game-assets/characters';

import {
  PRESENCE_STATUS,
  ROOM_STATUS,
  WAITING_ROOM_LIFETIME_MS,
} from '@/rooms/domain/room-constants';
import type { PlayingSeats, Room, Seat } from '@/rooms/domain/room-model';
import { isRoomCode } from '@/rooms/domain/room-validation';
import { isValidTimestamp } from '@/rooms/domain/time';

export function assertRoomInvariant(room: Room): void {
  invariant(room.id.length > 0, 'room id must not be empty');
  invariant(isRoomCode(room.code), 'room code must be six ASCII digits');
  assertTimestamp(room.createdAt, 'room createdAt');

  if (room.status === ROOM_STATUS.WAITING) {
    assertCreatorOnly(room.seats);
    assertWaitingExpiry(room.createdAt, room.expiresAt);
    assertPresence(room.seats[0], room.createdAt, false);
    return;
  }

  if (room.status === ROOM_STATUS.PLAYING) {
    assertPlayingSeats(room.seats);
    assertStartedAt(room.createdAt, room.startedAt);
    assertPlayingPresence(room.seats, room.createdAt);
    return;
  }

  invariant(room.status === ROOM_STATUS.FINISHED, 'unsupported room status');
  assertPlayingSeats(room.seats);
  assertStartedAt(room.createdAt, room.startedAt);
  assertTimestamp(room.finishedAt, 'room finishedAt');
  invariant(room.finishedAt >= room.startedAt, 'room finishedAt must not precede startedAt');
  assertPlayingPresence(room.seats, room.createdAt);
}

function assertCreatorOnly(seats: readonly Seat[]): void {
  invariant(seats.length === 1, 'waiting room must contain exactly one seat');
  assertProfile(seats[0]);
}

function assertPlayingSeats(seats: readonly Seat[]): asserts seats is PlayingSeats {
  invariant(seats.length === 2, 'playing lifecycle must contain exactly two seats');
  assertProfile(seats[0]);
  assertProfile(seats[1]);
}

function assertProfile(seat: Seat): void {
  invariant(isCharacterId(seat.profile.characterId), 'invalid profile character ID');
  invariant(typeof seat.profile.variant === 'boolean', 'invalid profile style');
}

function assertPlayingPresence(seats: PlayingSeats, createdAt: number): void {
  assertPresence(seats[0], createdAt, true);
  assertPresence(seats[1], createdAt, true);
}

function assertPresence(seat: Seat, createdAt: number, supportsReconnect: boolean): void {
  if (seat.presence.status === PRESENCE_STATUS.CONNECTED) {
    return;
  }

  invariant(seat.presence.status === PRESENCE_STATUS.DISCONNECTED, 'unsupported presence status');
  if (!supportsReconnect) {
    invariant(
      seat.presence.reconnectDeadlineAt === null,
      'waiting presence cannot have reconnect deadline',
    );
    return;
  }
  if (seat.presence.reconnectDeadlineAt === null) return;
  assertTimestamp(seat.presence.reconnectDeadlineAt, 'presence reconnectDeadlineAt');
  invariant(
    seat.presence.reconnectDeadlineAt >= createdAt,
    'reconnect deadline must not precede room creation',
  );
}

function assertWaitingExpiry(createdAt: number, expiresAt: number): void {
  assertTimestamp(expiresAt, 'waiting expiresAt');
  invariant(
    expiresAt === createdAt + WAITING_ROOM_LIFETIME_MS,
    'waiting expiry must remain fixed from room creation',
  );
}

function assertStartedAt(createdAt: number, startedAt: number): void {
  assertTimestamp(startedAt, 'room startedAt');
  invariant(startedAt >= createdAt, 'room startedAt must not precede creation');
  invariant(
    startedAt < createdAt + WAITING_ROOM_LIFETIME_MS,
    'room must start before waiting expiry',
  );
}

function assertTimestamp(value: number, label: string): void {
  invariant(isValidTimestamp(value), `${label} must be a valid timestamp`);
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Room invariant violated: ${message}`);
}
