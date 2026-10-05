import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import {
  actionIdSchema,
  clientIdSchema,
  epochMillisecondsSchema,
  roomCodeSchema,
  roomIdSchema,
  seatTokenSchema,
} from './primitives';

describe('wire primitives', () => {
  test('accepts UUID identifiers and a six-digit room code', () => {
    expect(String(v.parse(clientIdSchema, '018f47f2-c2d8-7f4a-8bf4-3f559c39843d'))).toBe(
      '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
    );
    expect(String(v.parse(actionIdSchema, 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d'))).toBe(
      'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
    );
    expect(String(v.parse(seatTokenSchema, 'd0379b77-4d7b-4611-83fc-d5dcde34bdc2'))).toBe(
      'd0379b77-4d7b-4611-83fc-d5dcde34bdc2',
    );
    expect(String(v.parse(roomCodeSchema, '001204'))).toBe('001204');
  });

  test.each(['not-a-uuid', '', '018f47f2-c2d8-7f4a-8bf4'])('rejects malformed IDs: %s', (value) => {
    expect(v.safeParse(clientIdSchema, value).success).toBeFalse();
  });

  test('enforces semantic UUID versions', () => {
    expect(v.safeParse(clientIdSchema, 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d').success).toBeFalse();
    expect(v.safeParse(roomIdSchema, '0ac23644-9a08-4ec6-98b4-e8b9838ee8d4').success).toBeFalse();
    expect(
      v.safeParse(seatTokenSchema, '018f47f2-c2d8-7f4a-8bf4-3f559c39843e').success,
    ).toBeFalse();
  });

  test.each(['12345', '1234567', '12a456', 123456])('rejects malformed room codes: %s', (value) => {
    expect(v.safeParse(roomCodeSchema, value).success).toBeFalse();
  });

  test.each([0, Number.MAX_SAFE_INTEGER])(
    'accepts safe epoch millisecond boundaries: %s',
    (value) => {
      expect(Number(v.parse(epochMillisecondsSchema, value))).toBe(value);
    },
  );

  test.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'])(
    'rejects malformed epoch milliseconds: %s',
    (value) => {
      expect(v.safeParse(epochMillisecondsSchema, value).success).toBeFalse();
    },
  );
});
