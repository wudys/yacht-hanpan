import { describe, expect, it } from 'bun:test';

import { isRoomCode, isValidTimestamp } from '@/rooms/domain/room-validation';

describe('room value validation', () => {
  it.each(['000000', '012345', '999999'])('accepts six ASCII digits: %s', (value) => {
    expect(isRoomCode(value)).toBe(true);
  });

  it.each(['12345', '1234567', '12 456', '１２３４５６', 'abcdef', 123456, null])(
    'rejects a malformed room code: %p',
    (value) => {
      expect(isRoomCode(value)).toBe(false);
    },
  );

  it.each([0, 1, 1_000, Number.MAX_SAFE_INTEGER])('accepts valid timestamp %p', (value) => {
    expect(isValidTimestamp(value)).toBe(true);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, '0', null])(
    'rejects valid timestamp %p',
    (value) => {
      expect(isValidTimestamp(value)).toBe(false);
    },
  );
});
