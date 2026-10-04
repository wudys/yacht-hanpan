import { describe, expect, it } from 'bun:test';

import { evaluateCleanup } from '@/rooms/domain/cleanup-policy';
import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { resumeSeat } from '@/rooms/domain/presence';
import { ROOM_CLEANUP_REASON, ROOM_REJECTION_CODE } from '@/rooms/domain/room-constants';
import { markGameFinished } from '@/rooms/domain/room-lifecycle';
import {
  type FinishedRoom,
  type PlayingRoom,
  roomId,
  type WaitingRoom,
} from '@/rooms/domain/room-model';

function waitingRoom(): WaitingRoom {
  const result = createRoom({
    roomId: roomId('room-1'),
    code: '012345',
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!result.ok) throw new Error('fixture creation failed');
  return result.room;
}

function playingRoom(): PlayingRoom {
  const result = joinRoom(waitingRoom(), {
    characterId: 'blonde-buns',
    variant: false,
    joinedAt: 2_000,
  });
  if (!result.ok || !result.changed) throw new Error('fixture join failed');
  return result.room;
}

function finishedRoom(): FinishedRoom {
  const result = markGameFinished(playingRoom(), { finishedAt: 10_000 });
  if (!result.ok || !result.changed) throw new Error('fixture finish failed');
  return result.room;
}

describe('evaluateCleanup', () => {
  it('selects a waiting room at the fixed expiry even while its creator is connected', () => {
    const connected = resumeSeat(waitingRoom(), { seatIndex: 0, resumedAt: 2_000 });
    if (!connected.ok) throw new Error('fixture connection failed');
    const { room } = connected;

    expect(evaluateCleanup(room, { checkedAt: room.expiresAt - 1 })).toEqual({
      ok: true,
      reason: null,
    });
    expect(evaluateCleanup(room, { checkedAt: room.expiresAt })).toEqual({
      ok: true,
      reason: ROOM_CLEANUP_REASON.WAITING_EXPIRED,
    });
  });

  it('selects a finished room from its finish time', () => {
    const room = finishedRoom();
    expect(evaluateCleanup(room, { checkedAt: room.finishedAt })).toEqual({
      ok: true,
      reason: ROOM_CLEANUP_REASON.GAME_FINISHED,
    });
  });

  it('does not select a playing room even after the original waiting expiry', () => {
    expect(evaluateCleanup(playingRoom(), { checkedAt: 400_000 })).toEqual({
      ok: true,
      reason: null,
    });
  });

  it('rejects an invalid cleanup timestamp', () => {
    const room = finishedRoom();
    for (const checkedAt of [-1, room.finishedAt - 1]) {
      expect(evaluateCleanup(room, { checkedAt })).toEqual({
        ok: false,
        code: ROOM_REJECTION_CODE.INVALID_TIMESTAMP,
      });
    }
  });
});
