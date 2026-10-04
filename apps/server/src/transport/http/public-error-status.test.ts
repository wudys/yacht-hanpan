import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { describe, expect, test } from 'bun:test';

import { httpStatusForPublicError } from '@/transport/http/public-error-status';

describe('public error mapping', () => {
  test('maps rate limiting, room conflicts, and internal failures to their HTTP statuses', () => {
    expect(httpStatusForPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED)).toBe(429);
    expect(httpStatusForPublicError(PUBLIC_ERROR_CODE.ROOM_ALREADY_MATCHED)).toBe(409);
    expect(httpStatusForPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR)).toBe(500);
  });
});
