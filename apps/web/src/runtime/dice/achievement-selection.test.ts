import { SPECIAL_COMBINATION } from '@repo/yacht-rules';
import { expect, test } from 'vitest';

import { selectFeaturedCombination } from '@/runtime/dice/achievement-selection';

test('features Yacht and Large Straight regardless of classification order', () => {
  expect(
    selectFeaturedCombination([SPECIAL_COMBINATION.FOUR_OF_A_KIND, SPECIAL_COMBINATION.YACHT]),
  ).toBe(SPECIAL_COMBINATION.YACHT);
  expect(
    selectFeaturedCombination([SPECIAL_COMBINATION.YACHT, SPECIAL_COMBINATION.FOUR_OF_A_KIND]),
  ).toBe(SPECIAL_COMBINATION.YACHT);
  expect(
    selectFeaturedCombination([
      SPECIAL_COMBINATION.SMALL_STRAIGHT,
      SPECIAL_COMBINATION.LARGE_STRAIGHT,
    ]),
  ).toBe(SPECIAL_COMBINATION.LARGE_STRAIGHT);
  expect(
    selectFeaturedCombination([
      SPECIAL_COMBINATION.LARGE_STRAIGHT,
      SPECIAL_COMBINATION.SMALL_STRAIGHT,
    ]),
  ).toBe(SPECIAL_COMBINATION.LARGE_STRAIGHT);
});

test('features a lone combination and skips rolls without one', () => {
  expect(selectFeaturedCombination([SPECIAL_COMBINATION.FULL_HOUSE])).toBe(
    SPECIAL_COMBINATION.FULL_HOUSE,
  );
  expect(selectFeaturedCombination([])).toBeNull();
});
