import { describe, expect, it } from 'bun:test';

import { isRoomCode } from '@/rooms/domain/room-validation';

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
});
