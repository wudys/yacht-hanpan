import { describe, expect, test } from 'bun:test';

import { CATEGORY_ID, CATEGORY_IDS, SPECIAL_COMBINATION } from './constants';
import type { Dice, DieFace } from './dice';
import { findSpecialCombinations, scoreCategory } from './scoring';

const FACES = [1, 2, 3, 4, 5, 6] as const;

describe('category scoring', () => {
  test.each([
    [CATEGORY_ID.ONES, 1, 2, 3, 5],
    [CATEGORY_ID.TWOS, 2, 1, 6, 10],
    [CATEGORY_ID.THREES, 3, 1, 9, 15],
    [CATEGORY_ID.FOURS, 4, 1, 12, 20],
    [CATEGORY_ID.FIVES, 5, 1, 15, 25],
    [CATEGORY_ID.SIXES, 6, 1, 18, 30],
  ] as const)(
    'scores %s with zero, three, and five matching dice',
    (category, face, other, three, five) => {
      expect(scoreCategory(category, [other, other, other, other, other])).toBe(0);
      expect(scoreCategory(category, [face, other, face, other, face])).toBe(three);
      expect(scoreCategory(category, [face, face, face, face, face])).toBe(five);
    },
  );

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

  // Fixed rule examples are the correctness oracle; the exhaustive test below
  // establishes order invariance and bounds, not an independent scoring formula.
  test.each([
    { category: CATEGORY_ID.CHOICE, dice: [1, 1, 1, 1, 1], score: 5 },
    { category: CATEGORY_ID.CHOICE, dice: [6, 6, 6, 6, 6], score: 30 },
    { category: CATEGORY_ID.FOUR_OF_A_KIND, dice: [6, 6, 6, 6, 5], score: 29 },
    { category: CATEGORY_ID.FOUR_OF_A_KIND, dice: [5, 5, 5, 5, 5], score: 25 },
    { category: CATEGORY_ID.FOUR_OF_A_KIND, dice: [6, 6, 6, 5, 5], score: 0 },
    { category: CATEGORY_ID.FULL_HOUSE, dice: [6, 6, 6, 5, 5], score: 28 },
    { category: CATEGORY_ID.FULL_HOUSE, dice: [1, 1, 1, 2, 2], score: 7 },
    { category: CATEGORY_ID.FULL_HOUSE, dice: [6, 6, 6, 6, 6], score: 0 },
    { category: CATEGORY_ID.FULL_HOUSE, dice: [6, 6, 6, 6, 5], score: 0 },
    { category: CATEGORY_ID.FULL_HOUSE, dice: [6, 6, 5, 5, 4], score: 0 },
    { category: CATEGORY_ID.SMALL_STRAIGHT, dice: [1, 2, 3, 4, 6], score: 15 },
    { category: CATEGORY_ID.SMALL_STRAIGHT, dice: [1, 2, 2, 3, 4], score: 15 },
    { category: CATEGORY_ID.SMALL_STRAIGHT, dice: [2, 3, 4, 5, 5], score: 15 },
    { category: CATEGORY_ID.SMALL_STRAIGHT, dice: [3, 4, 5, 6, 6], score: 15 },
    { category: CATEGORY_ID.SMALL_STRAIGHT, dice: [2, 3, 4, 5, 6], score: 15 },
    { category: CATEGORY_ID.SMALL_STRAIGHT, dice: [1, 2, 3, 5, 6], score: 0 },
    { category: CATEGORY_ID.LARGE_STRAIGHT, dice: [1, 2, 3, 4, 5], score: 30 },
    { category: CATEGORY_ID.LARGE_STRAIGHT, dice: [2, 3, 4, 5, 6], score: 30 },
    { category: CATEGORY_ID.LARGE_STRAIGHT, dice: [5, 1, 4, 2, 3], score: 30 },
    { category: CATEGORY_ID.LARGE_STRAIGHT, dice: [6, 2, 5, 3, 4], score: 30 },
    { category: CATEGORY_ID.LARGE_STRAIGHT, dice: [1, 2, 3, 4, 4], score: 0 },
    { category: CATEGORY_ID.LARGE_STRAIGHT, dice: [1, 2, 3, 5, 6], score: 0 },
  ] as const)('scores $category for $dice as $score', ({ category, dice, score }) => {
    expect(scoreCategory(category, dice)).toBe(score);
  });

  test.each([...FACES])('scores Yacht only when all five faces match %i', (face) => {
    const other = face === 1 ? 2 : 1;
    expect(scoreCategory(CATEGORY_ID.YACHT, [face, face, face, face, face])).toBe(50);
    expect(scoreCategory(CATEGORY_ID.YACHT, [face, face, face, face, other])).toBe(0);
  });

  test('preserves scores and combinations across every ordering of all 252 multisets', () => {
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

    const multisets = new Map<string, ReturnType<typeof evaluateDice>>();
    for (const a of FACES) {
      for (const b of FACES) {
        for (const c of FACES) {
          for (const d of FACES) {
            for (const e of FACES) {
              const dice: Dice = [a, b, c, d, e];
              const sorted: [DieFace, DieFace, DieFace, DieFace, DieFace] = [...dice];
              sorted.sort((left, right) => left - right);
              const key = sorted.join(',');
              let expected = multisets.get(key);
              if (expected === undefined) {
                expected = evaluateDice(sorted);
                multisets.set(key, expected);
                expected.scores.forEach((score, index) => {
                  expect(Number.isInteger(score)).toBe(true);
                  expect(score).toBeGreaterThanOrEqual(0);
                  expect(score).toBeLessThanOrEqual(maxima[CATEGORY_IDS[index]!]);
                });
              }
              expect(evaluateDice(dice)).toEqual(expected);
            }
          }
        }
      }
    }
    expect(multisets.size).toBe(252);
  });

  test('does not reorder the caller’s dice while scoring or classifying', () => {
    const dice: Dice = [5, 1, 4, 2, 3];
    const before: Dice = [...dice];
    for (const category of CATEGORY_IDS) {
      scoreCategory(category, dice);
      expect(dice).toEqual(before);
    }
    findSpecialCombinations(dice);
    expect(dice).toEqual(before);
  });
});

describe('special-combination classification', () => {
  test('returns every matching category for a Yacht', () => {
    expect(new Set(findSpecialCombinations([6, 6, 6, 6, 6]))).toEqual(
      new Set([SPECIAL_COMBINATION.YACHT, SPECIAL_COMBINATION.FOUR_OF_A_KIND]),
    );
  });

  test.each([
    { dice: [1, 2, 3, 4, 5] },
    { dice: [5, 1, 4, 2, 3] },
    { dice: [6, 2, 5, 3, 4] },
  ] as const)('returns both overlapping straights for $dice', ({ dice }) => {
    expect(new Set(findSpecialCombinations(dice))).toEqual(
      new Set([SPECIAL_COMBINATION.LARGE_STRAIGHT, SPECIAL_COMBINATION.SMALL_STRAIGHT]),
    );
  });

  test('recognizes exact Full House and no special combination', () => {
    expect(findSpecialCombinations([6, 6, 6, 5, 5])).toEqual([SPECIAL_COMBINATION.FULL_HOUSE]);
    expect(findSpecialCombinations([1, 1, 2, 3, 6])).toEqual([]);
  });

  test('classifies partial straights and four of a kind without promoting them', () => {
    expect(findSpecialCombinations([1, 2, 2, 3, 4])).toEqual([SPECIAL_COMBINATION.SMALL_STRAIGHT]);
    expect(findSpecialCombinations([6, 6, 5, 6, 6])).toEqual([SPECIAL_COMBINATION.FOUR_OF_A_KIND]);
  });
});

function evaluateDice(dice: Dice) {
  return {
    scores: CATEGORY_IDS.map((category) => scoreCategory(category, dice)),
    combinations: new Set(findSpecialCombinations(dice)),
  };
}
