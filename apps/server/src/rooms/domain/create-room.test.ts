import { describe, expect, it } from 'bun:test';

import { createRoom } from '@/rooms/domain/create-room';
import { PRESENCE_STATUS, ROOM_REJECTION_CODE, ROOM_STATUS } from '@/rooms/domain/room-constants';
import { roomId } from '@/rooms/domain/room-model';

const validInput = {
  roomId: roomId('room-1'),
  code: '000123',
  characterId: 'sage-bucket',
  variant: false,
  createdAt: 1_000,
} as const;

describe('createRoom', () => {
  it('creates one creator seat and a fixed five-minute waiting expiry', () => {
    const result = createRoom(validInput);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('room creation failed');
    expect(result.room).toMatchObject({
      id: validInput.roomId,
      code: '000123',
      status: ROOM_STATUS.WAITING,
      createdAt: 1_000,
      expiresAt: 301_000,
    });
    expect(result.room.seats).toEqual([
      {
        profile: { characterId: 'sage-bucket', variant: false },
        presence: {
          status: PRESENCE_STATUS.DISCONNECTED,
          reconnectDeadlineAt: null,
        },
      },
    ]);
  });

  it.each([
    [{ ...validInput, code: '12345' }, ROOM_REJECTION_CODE.INVALID_ROOM_CODE],
    [{ ...validInput, characterId: 9 }, ROOM_REJECTION_CODE.INVALID_PROFILE],
    [{ ...validInput, createdAt: -1 }, ROOM_REJECTION_CODE.INVALID_TIMESTAMP],
    [{ ...validInput, createdAt: Number.MAX_SAFE_INTEGER }, ROOM_REJECTION_CODE.INVALID_TIMESTAMP],
  ])('rejects invalid creation input without a room: %p', (input, code) => {
    expect(createRoom(input)).toEqual({ ok: false, code });
  });
});
