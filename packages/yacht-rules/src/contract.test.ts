import {
  CATEGORY_ID,
  CATEGORY_IDS,
  LOWER_CATEGORY_IDS,
  UPPER_CATEGORY_IDS,
} from '@repo/yacht-rules';
import { describe, expect, test } from 'bun:test';

describe('public Yacht rules contract', () => {
  test('defines one ordered, unique vocabulary for all 12 categories', () => {
    expect(CATEGORY_IDS).toEqual([
      'ones',
      'twos',
      'threes',
      'fours',
      'fives',
      'sixes',
      'choice',
      'four-of-a-kind',
      'full-house',
      'small-straight',
      'large-straight',
      'yacht',
    ]);
    expect(new Set(CATEGORY_IDS).size).toBe(12);
    expect([...UPPER_CATEGORY_IDS, ...LOWER_CATEGORY_IDS]).toEqual([...CATEGORY_IDS]);
    expect(CATEGORY_ID.YACHT).toBe('yacht');
  });
});
