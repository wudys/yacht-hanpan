import { describe, expect, test } from 'bun:test';

import { GameApiParseError, parseWith } from '../internal/parse';
import { type ErrorParamsByCode, PUBLIC_ERROR_CODE } from './index';
import { publicErrorSchema } from './schemas';

const VALID_PARAMS = {
  [PUBLIC_ERROR_CODE.INVALID_REQUEST]: {},
  [PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH]: {},
  [PUBLIC_ERROR_CODE.ROOM_NOT_FOUND]: {},
  [PUBLIC_ERROR_CODE.ROOM_NOT_JOINABLE]: {},
  [PUBLIC_ERROR_CODE.ROOM_ALREADY_MATCHED]: {},
  [PUBLIC_ERROR_CODE.ROOM_CODE_EXHAUSTED]: {},
  [PUBLIC_ERROR_CODE.INVALID_AUTHORITY]: {},
  [PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE]: {},
  [PUBLIC_ERROR_CODE.SESSION_REPLACED]: {},
  [PUBLIC_ERROR_CODE.NOT_YOUR_TURN]: {},
  [PUBLIC_ERROR_CODE.STALE_TURN]: {},
  [PUBLIC_ERROR_CODE.TURN_EXPIRED]: {},
  [PUBLIC_ERROR_CODE.ROLL_LIMIT_REACHED]: {},
  [PUBLIC_ERROR_CODE.NO_DICE_TO_ROLL]: {},
  [PUBLIC_ERROR_CODE.HOLD_NOT_ALLOWED]: {},
  [PUBLIC_ERROR_CODE.CATEGORY_ALREADY_RECORDED]: {},
  [PUBLIC_ERROR_CODE.INVALID_CATEGORY]: {},
  [PUBLIC_ERROR_CODE.MATCH_FINISHED]: {},
  [PUBLIC_ERROR_CODE.ACTION_ID_REUSED]: {},
  [PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED]: {},
  [PUBLIC_ERROR_CODE.RATE_LIMITED]: { retryAfterMs: 1_500 },
  [PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE]: {},
  [PUBLIC_ERROR_CODE.INTERNAL_ERROR]: {},
} satisfies ErrorParamsByCode;

describe('public errors', () => {
  test.each(Object.values(PUBLIC_ERROR_CODE))('parses valid params for %s', (code) => {
    const error = { code, params: VALID_PARAMS[code] };
    expect(error).toEqual(parseWith(publicErrorSchema, error));
  });

  test.each(Object.values(PUBLIC_ERROR_CODE))('rejects extra params for %s', (code) => {
    expect(() =>
      parseWith(publicErrorSchema, {
        code,
        params: { ...VALID_PARAMS[code], privateDetail: 'hidden' },
      }),
    ).toThrow(GameApiParseError);
  });

  test.each([
    { code: 'UNKNOWN', params: {} },
    { code: 'WAITING_ROOM_EXISTS', params: {} },
    { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: { roomCode: '123456' } },
    { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: {} },
    { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: -1 } },
    { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: 1.5 } },
    { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: '1000' } },
    { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: Number.POSITIVE_INFINITY } },
    { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {}, message: 'private' },
  ])('rejects unsafe or malformed public errors', (value) => {
    expect(() => parseWith(publicErrorSchema, value)).toThrow(GameApiParseError);
  });

  test('never serializes localized or private data', () => {
    const error = parseWith(publicErrorSchema, {
      code: PUBLIC_ERROR_CODE.INTERNAL_ERROR,
      params: {},
    });
    const json = JSON.stringify(error);
    expect(json).not.toMatch(/message|messageKey|i18n|stack|token|path|validation/iu);
  });
});
