import { describe, expect, test } from 'bun:test';

import { seededNumber } from './seed-expander';

describe('versioned deterministic seed expansion', () => {
  test.each([
    ['seed-1', 0, 0.22806244606208728],
    ['seed-1', 1, 0.19988089104811882],
    ['golden-seed', 42, 0.1815876549434158],
    ['한판', 7, 0.16084478079844702],
  ] as const)(
    'expands %s:%d with the reviewed SHA-256 counter fixture',
    (seed, index, expected) => {
      expect(seededNumber(seed, index)).toBe(expected);
    },
  );
});
