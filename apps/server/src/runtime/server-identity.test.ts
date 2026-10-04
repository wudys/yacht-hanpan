import { describe, expect, test } from 'bun:test';
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

  test('generates six-digit room codes with leading zeroes', () => {
    for (let index = 0; index < 100; index += 1) {
      expect(identity.createRoomCodeCandidate()).toMatch(/^\d{6}$/u);
    }
  });
});
