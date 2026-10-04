import { isCharacterId } from '@repo/game-assets/characters';

import { PRESENCE_STATUS, ROOM_REJECTION_CODE, ROOM_STATUS } from '@/rooms/domain/room-constants';
import type { PlayingRoom, Room, RoomTransition } from '@/rooms/domain/room-model';
import { roomRejected } from '@/rooms/domain/room-transitions';
import { isTrustedTimestamp } from '@/rooms/domain/room-validation';
import { epochMilliseconds } from '@/rooms/domain/time';

export interface JoinRoomInput {
  readonly characterId: unknown;
  readonly variant: unknown;
  readonly joinedAt: unknown;
}

type JoinRoomResult = Exclude<
  RoomTransition<PlayingRoom>,
  { readonly ok: true; readonly changed: false }
>;

export function joinRoom(room: Room, input: JoinRoomInput): JoinRoomResult {
  if (!isCharacterId(input.characterId) || typeof input.variant !== 'boolean') {
    return roomRejected(room, ROOM_REJECTION_CODE.INVALID_PROFILE);
  }
  if (!isTrustedTimestamp(input.joinedAt) || input.joinedAt < room.createdAt) {
    return roomRejected(room, ROOM_REJECTION_CODE.INVALID_TIMESTAMP);
  }
  if (room.status !== ROOM_STATUS.WAITING) {
    return roomRejected(room, ROOM_REJECTION_CODE.ROOM_NOT_WAITING);
  }
  if (input.joinedAt >= room.expiresAt) {
    return roomRejected(room, ROOM_REJECTION_CODE.WAITING_ROOM_EXPIRED);
  }
  return {
    ok: true,
    changed: true,
    room: {
      id: room.id,
      code: room.code,
      status: ROOM_STATUS.PLAYING,
      createdAt: room.createdAt,
      startedAt: epochMilliseconds(input.joinedAt),
      seats: [
        room.seats[0],
        {
          profile: {
            characterId: input.characterId,
            variant: input.variant,
          },
          presence: {
            status: PRESENCE_STATUS.DISCONNECTED,
            reconnectDeadlineAt: null,
          },
        },
      ],
    },
  };
}
