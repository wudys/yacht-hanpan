import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { describe, expect, test } from 'bun:test';

import { MATCH_REJECTION_CODE } from '@/rooms/domain/match';
import { ROOM_REJECTION_CODE } from '@/rooms/domain/room-constants';
import { mapMatchRejection, mapRoomRejection } from '@/rooms/errors';

describe('public error mapping', () => {
  test('maps domain rejections to stable public codes', () => {
    expect(mapRoomRejection(ROOM_REJECTION_CODE.WAITING_ROOM_EXPIRED)).toBe(
      PUBLIC_ERROR_CODE.ROOM_NOT_JOINABLE,
    );
    expect(mapRoomRejection(ROOM_REJECTION_CODE.SEAT_NOT_FOUND)).toBe(
      PUBLIC_ERROR_CODE.INVALID_AUTHORITY,
    );
    expect(mapMatchRejection(MATCH_REJECTION_CODE.NOT_YOUR_TURN)).toBe(
      PUBLIC_ERROR_CODE.NOT_YOUR_TURN,
    );
    expect(mapMatchRejection(MATCH_REJECTION_CODE.MATCH_FINISHED)).toBe(
      PUBLIC_ERROR_CODE.MATCH_FINISHED,
    );
  });
});
