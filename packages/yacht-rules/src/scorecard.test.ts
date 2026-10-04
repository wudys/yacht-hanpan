import { describe, expect, test } from 'bun:test';

import { CATEGORY_ID, CATEGORY_IDS } from './constants';
import { countFilledCategories, previewScores, summarizeScorecard } from './scorecard';

describe('scorecard projection', () => {
  test('previews every empty category after a roll', () => {
    const previews = previewScores({}, [1, 2, 3, 4, 5]);

    expect(Object.keys(previews)).toEqual([...CATEGORY_IDS]);
    expect(previews[CATEGORY_ID.ONES]).toEqual({
      recorded: false,
      score: 1,
      selectable: true,
    });
    expect(previews[CATEGORY_ID.LARGE_STRAIGHT]).toEqual({
      recorded: false,
      score: 30,
      selectable: true,
    });
  });

  test('distinguishes recorded zero from an empty category', () => {
    const previews = previewScores({ [CATEGORY_ID.YACHT]: 0 }, [1, 1, 1, 1, 1]);

    expect(previews[CATEGORY_ID.YACHT]).toEqual({
      recorded: true,
      score: 0,
      selectable: false,
    });
    expect(countFilledCategories({ [CATEGORY_ID.YACHT]: 0 })).toBe(1);
  });

  test('returns no candidate score before the first roll', () => {
    const previews = previewScores({}, null);

    expect(previews[CATEGORY_ID.CHOICE]).toEqual({
      recorded: false,
      score: null,
      selectable: false,
    });
  });

  test('applies the upper bonus to the total only from 63 points', () => {
    const at62 = summarizeScorecard({
      [CATEGORY_ID.ONES]: 2,
      [CATEGORY_ID.TWOS]: 10,
      [CATEGORY_ID.THREES]: 15,
      [CATEGORY_ID.FOURS]: 20,
      [CATEGORY_ID.FIVES]: 15,
    });
    const at63 = summarizeScorecard({
      [CATEGORY_ID.ONES]: 3,
      [CATEGORY_ID.TWOS]: 10,
      [CATEGORY_ID.THREES]: 15,
      [CATEGORY_ID.FOURS]: 20,
      [CATEGORY_ID.FIVES]: 15,
    });

    expect(at62).toEqual({
      upperSubtotal: 62,
      upperBonus: 0,
      total: 62,
    });
    expect(at63).toEqual({
      upperSubtotal: 63,
      upperBonus: 35,
      total: 98,
    });
  });

  test('matches the canonical maximum total of 323', () => {
    const summary = summarizeScorecard({
      [CATEGORY_ID.ONES]: 5,
      [CATEGORY_ID.TWOS]: 10,
      [CATEGORY_ID.THREES]: 15,
      [CATEGORY_ID.FOURS]: 20,
      [CATEGORY_ID.FIVES]: 25,
      [CATEGORY_ID.SIXES]: 30,
      [CATEGORY_ID.CHOICE]: 30,
      [CATEGORY_ID.FOUR_OF_A_KIND]: 30,
      [CATEGORY_ID.FULL_HOUSE]: 28,
      [CATEGORY_ID.SMALL_STRAIGHT]: 15,
      [CATEGORY_ID.LARGE_STRAIGHT]: 30,
      [CATEGORY_ID.YACHT]: 50,
    });

    expect(summary).toEqual({
      upperSubtotal: 105,
      upperBonus: 35,
      total: 323,
    });
  });
});
