import { isCharacterId } from '@repo/game-assets/characters';

import {
  PRESENCE_STATUS,
  ROOM_REJECTION_CODE,
  ROOM_STATUS,
  WAITING_ROOM_LIFETIME_MS,
} from '@/rooms/domain/room-constants';
import type { RoomCreationResult, RoomId } from '@/rooms/domain/room-model';
import { isRoomCode } from '@/rooms/domain/room-validation';
import { epochMilliseconds, isValidTimestamp } from '@/rooms/domain/time';

export interface CreateRoomInput {
  readonly roomId: RoomId;
  readonly code: unknown;
  readonly characterId: unknown;
  readonly variant: unknown;
  readonly createdAt: unknown;
}

export function createRoom(input: CreateRoomInput): RoomCreationResult {
  if (!isRoomCode(input.code)) {
    return { ok: false, code: ROOM_REJECTION_CODE.INVALID_ROOM_CODE };
  }
  if (!isCharacterId(input.characterId) || typeof input.variant !== 'boolean') {
    return { ok: false, code: ROOM_REJECTION_CODE.INVALID_PROFILE };
  }
  if (
    !isValidTimestamp(input.createdAt) ||
    !isValidTimestamp(input.createdAt + WAITING_ROOM_LIFETIME_MS)
  ) {
    return { ok: false, code: ROOM_REJECTION_CODE.INVALID_TIMESTAMP };
  }

  const createdAt = epochMilliseconds(input.createdAt);

  return {
    ok: true,
    room: {
      id: input.roomId,
      code: input.code,
      status: ROOM_STATUS.WAITING,
      createdAt,
      expiresAt: epochMilliseconds(input.createdAt + WAITING_ROOM_LIFETIME_MS),
      seats: [
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
