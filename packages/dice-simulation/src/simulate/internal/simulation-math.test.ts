import { expect, test } from 'bun:test';

import { normalizedQuatDistance, quatDistance } from './simulation-math';

test('normalized pose distance ignores quaternion length without changing the non-normalized pose distance', () => {
  expect(normalizedQuatDistance([0, 0, 0, 0.9999], [0, 0, 0, 1])).toBe(0);
  expect(quatDistance([0, 0, 0, 0.9999], [0, 0, 0, 1])).toBeGreaterThan(0.012);
  expect(normalizedQuatDistance([0, 0, 0, 1], [0, 0, 0, -1])).toBe(0);
  expect(normalizedQuatDistance([0, 0, 0, 1], [0, 0, Math.sin(0.1), Math.cos(0.1)])).toBeCloseTo(
    0.2,
  );
});
