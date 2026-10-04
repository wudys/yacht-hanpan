import { describe, expect, test } from 'bun:test';

import { CATEGORY_ID, CATEGORY_IDS, SPECIAL_COMBINATION } from './constants';
import type { Dice, DieFace } from './dice';
import { findSpecialCombinations, scoreCategory } from './scoring';

describe('category scoring', () => {
  test('scores upper categories and Choice', () => {
    const dice: Dice = [1, 2, 3, 4, 4];
    expect(scoreCategory(CATEGORY_ID.ONES, dice)).toBe(1);
    expect(scoreCategory(CATEGORY_ID.TWOS, dice)).toBe(2);
    expect(scoreCategory(CATEGORY_ID.THREES, dice)).toBe(3);
    expect(scoreCategory(CATEGORY_ID.FOURS, dice)).toBe(8);
    expect(scoreCategory(CATEGORY_ID.FIVES, dice)).toBe(0);
    expect(scoreCategory(CATEGORY_ID.SIXES, dice)).toBe(0);
    expect(scoreCategory(CATEGORY_ID.CHOICE, dice)).toBe(14);
  });

  test('scores 4 of a Kind on four or more matching dice', () => {
    expect(scoreCategory(CATEGORY_ID.FOUR_OF_A_KIND, [6, 6, 6, 6, 5])).toBe(29);
    expect(scoreCategory(CATEGORY_ID.FOUR_OF_A_KIND, [5, 5, 5, 5, 5])).toBe(25);
    expect(scoreCategory(CATEGORY_ID.FOUR_OF_A_KIND, [6, 6, 6, 5, 5])).toBe(0);
  });

  test('scores Full House only for exact 2+3 groups', () => {
    expect(scoreCategory(CATEGORY_ID.FULL_HOUSE, [6, 6, 6, 5, 5])).toBe(28);
    expect(scoreCategory(CATEGORY_ID.FULL_HOUSE, [6, 6, 6, 6, 6])).toBe(0);
    expect(scoreCategory(CATEGORY_ID.FULL_HOUSE, [6, 6, 5, 5, 4])).toBe(0);
  });

  test('scores Small Straight for four or more distinct consecutive values', () => {
    expect(scoreCategory(CATEGORY_ID.SMALL_STRAIGHT, [1, 2, 3, 4, 6])).toBe(15);
    expect(scoreCategory(CATEGORY_ID.SMALL_STRAIGHT, [1, 2, 2, 3, 4])).toBe(15);
    expect(scoreCategory(CATEGORY_ID.SMALL_STRAIGHT, [2, 3, 4, 5, 6])).toBe(15);
    expect(scoreCategory(CATEGORY_ID.SMALL_STRAIGHT, [1, 2, 3, 5, 6])).toBe(0);
  });

  test('scores both canonical Large Straights and rejects gaps or duplicates', () => {
    expect(scoreCategory(CATEGORY_ID.LARGE_STRAIGHT, [1, 2, 3, 4, 5])).toBe(30);
    expect(scoreCategory(CATEGORY_ID.LARGE_STRAIGHT, [2, 3, 4, 5, 6])).toBe(30);
    expect(scoreCategory(CATEGORY_ID.LARGE_STRAIGHT, [1, 2, 3, 4, 4])).toBe(0);
    expect(scoreCategory(CATEGORY_ID.LARGE_STRAIGHT, [1, 2, 3, 5, 6])).toBe(0);
  });

  test('scores Yacht only when all five faces match', () => {
    expect(scoreCategory(CATEGORY_ID.YACHT, [4, 4, 4, 4, 4])).toBe(50);
    expect(scoreCategory(CATEGORY_ID.YACHT, [4, 4, 4, 4, 3])).toBe(0);
  });

  test('keeps every score within canonical bounds across all 6^5 rolls', () => {
    const maxima = {
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
    } as const;

    for (let a = 1; a <= 6; a += 1) {
      for (let b = 1; b <= 6; b += 1) {
        for (let c = 1; c <= 6; c += 1) {
          for (let d = 1; d <= 6; d += 1) {
            for (let e = 1; e <= 6; e += 1) {
              const dice: Dice = [a, b, c, d, e] as DieFace[] as unknown as Dice;
              for (const categoryId of CATEGORY_IDS) {
                const score = scoreCategory(categoryId, dice);
                expect(Number.isInteger(score)).toBe(true);
                expect(score).toBeGreaterThanOrEqual(0);
                expect(score).toBeLessThanOrEqual(maxima[categoryId]);
              }
            }
          }
        }
      }
    }
  });
});

describe('special-combination classification', () => {
  test('returns every matching category for a Yacht', () => {
    expect(new Set(findSpecialCombinations([6, 6, 6, 6, 6]))).toEqual(
      new Set([SPECIAL_COMBINATION.YACHT, SPECIAL_COMBINATION.FOUR_OF_A_KIND]),
    );
  });

  test('returns both overlapping straights', () => {
    expect(new Set(findSpecialCombinations([1, 2, 3, 4, 5]))).toEqual(
      new Set([SPECIAL_COMBINATION.LARGE_STRAIGHT, SPECIAL_COMBINATION.SMALL_STRAIGHT]),
    );
  });

  test('recognizes exact Full House and no special combination', () => {
    expect(findSpecialCombinations([6, 6, 6, 5, 5])).toEqual([SPECIAL_COMBINATION.FULL_HOUSE]);
    expect(findSpecialCombinations([1, 1, 2, 3, 6])).toEqual([]);
  });
});
