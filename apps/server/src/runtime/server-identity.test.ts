import * as crypto from 'node:crypto';

import { describe, expect, spyOn, test } from 'bun:test';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

import { createProductionIdentity } from '@/runtime/server-identity';

describe('production semantic identity', () => {
  const identity = createProductionIdentity();

  test('generates UUID v7 semantic IDs', () => {
    for (const value of [
      identity.createRoomId(),
      identity.createTurnId(),
      identity.createRequestId(),
    ]) {
      expect(validateUuid(value)).toBeTrue();
      expect(uuidVersion(value)).toBe(7);
    }
  });

  test('generates UUID v4 seat authority', () => {
    const token = identity.createSeatToken();
    expect(validateUuid(token)).toBeTrue();
    expect(uuidVersion(token)).toBe(4);
  });

  test.each([
    [0, '000000'],
    [123, '000123'],
    [999_999, '999999'],
  ] as const)('formats random room code %i as %s', (value, expected) => {
    const randomInt = spyOn(crypto, 'randomInt').mockImplementation(() => value);
    try {
      expect(identity.createRoomCodeCandidate()).toBe(expected);
      expect(randomInt).toHaveBeenCalledTimes(1);
      expect(randomInt).toHaveBeenCalledWith(0, 1_000_000);
    } finally {
      randomInt.mockRestore();
    }
  });
});
