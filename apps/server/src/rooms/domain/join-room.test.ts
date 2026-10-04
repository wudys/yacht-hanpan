import type { CharacterId } from '@repo/game-assets/characters';
import { describe, expect, it } from 'bun:test';

import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { PRESENCE_STATUS, ROOM_REJECTION_CODE, ROOM_STATUS } from '@/rooms/domain/room-constants';
import { roomId, type WaitingRoom } from '@/rooms/domain/room-model';

function waitingRoom(characterId: CharacterId = 'sage-bucket'): WaitingRoom {
  const result = createRoom({
    roomId: roomId('room-1'),
    code: '012345',
    characterId,
    variant: false,
    createdAt: 1_000,
  });

  if (!result.ok) throw new Error('fixture creation failed');
  return result.room;
}

describe('joinRoom', () => {
  it.each(['sage-bucket', 'rose-tails'] as const)(
    'joins character %s before expiry',
    (characterId) => {
      const room = waitingRoom();
      const result = joinRoom(room, {
        characterId,
        variant: false,
        joinedAt: room.expiresAt - 1,
      });

      expect(result.ok).toBe(true);
      expect(result.changed).toBe(true);
      expect(result.room).toMatchObject({
        status: ROOM_STATUS.PLAYING,
        startedAt: room.expiresAt - 1,
        createdAt: room.createdAt,
        code: room.code,
        seats: [
          room.seats[0],
          {
            profile: { characterId, variant: false },
            presence: {
              status: PRESENCE_STATUS.DISCONNECTED,
              reconnectDeadlineAt: null,
            },
          },
        ],
      });
      expect(room.status).toBe(ROOM_STATUS.WAITING);
      expect(room.seats).toHaveLength(1);
      expect(result.room.seats[0].profile.variant).toBe(false);
      expect(result.room.seats[1]?.profile.variant).toBe(false);
    },
  );

  it.each([
    [301_000, ROOM_REJECTION_CODE.WAITING_ROOM_EXPIRED],
    [301_001, ROOM_REJECTION_CODE.WAITING_ROOM_EXPIRED],
    [-1, ROOM_REJECTION_CODE.INVALID_TIMESTAMP],
    [999, ROOM_REJECTION_CODE.INVALID_TIMESTAMP],
  ])('rejects joinedAt %d with %s', (joinedAt, code) => {
    const room = waitingRoom();
    const result = joinRoom(room, {
      characterId: 'rose-tails',
      variant: false,
      joinedAt,
    });

    expect(result).toEqual({ ok: false, changed: false, room, code });
    expect(result.room).toBe(room);
  });

  it('allows joining at creation time', () => {
    const room = waitingRoom();
    expect(
      joinRoom(room, { characterId: 'rose-tails', variant: false, joinedAt: room.createdAt }),
    ).toMatchObject({ ok: true, changed: true, room: { startedAt: room.createdAt } });
  });

  it('rejects a second join and preserves the playing room', () => {
    const first = joinRoom(waitingRoom(), {
      characterId: 'rose-tails',
      variant: false,
      joinedAt: 2_000,
    });
    if (!first.ok || !first.changed) throw new Error('fixture join failed');

    expect(
      joinRoom(first.room, {
        characterId: 'black-hime',
        variant: false,
        joinedAt: 3_000,
      }),
    ).toEqual({
      ok: false,
      changed: false,
      room: first.room,
      code: ROOM_REJECTION_CODE.ROOM_NOT_WAITING,
    });
  });
});
