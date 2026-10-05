import { describe, expect, test } from 'bun:test';

import { epochMilliseconds, isValidTimestamp } from '@/rooms/domain/time';

describe('isValidTimestamp', () => {
  test.each([0, 1, 1_000, Number.MAX_SAFE_INTEGER])('accepts valid timestamp %p', (value) => {
    expect(isValidTimestamp(value)).toBe(true);
  });

  test.each([
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '0',
    null,
  ])('rejects invalid timestamp %p', (value) => {
    expect(isValidTimestamp(value)).toBe(false);
  });
});

describe('epochMilliseconds', () => {
  test.each([0, 1, 1_000, Number.MAX_SAFE_INTEGER])('accepts %p unchanged', (value) => {
    expect<number>(epochMilliseconds(value)).toBe(value);
  });

  test.each([
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ])('rejects %p with the constructor error', (value) => {
    expect(() => epochMilliseconds(value)).toThrow(
      'EpochMilliseconds must be a non-negative safe integer',
    );
  });
});
