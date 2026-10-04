export const CATEGORY_ID = {
  ONES: 'ones',
  TWOS: 'twos',
  THREES: 'threes',
  FOURS: 'fours',
  FIVES: 'fives',
  SIXES: 'sixes',
  CHOICE: 'choice',
  FOUR_OF_A_KIND: 'four-of-a-kind',
  FULL_HOUSE: 'full-house',
  SMALL_STRAIGHT: 'small-straight',
  LARGE_STRAIGHT: 'large-straight',
  YACHT: 'yacht',
} as const;

export type CategoryId = (typeof CATEGORY_ID)[keyof typeof CATEGORY_ID];

export const UPPER_CATEGORY_IDS = [
  CATEGORY_ID.ONES,
  CATEGORY_ID.TWOS,
  CATEGORY_ID.THREES,
  CATEGORY_ID.FOURS,
  CATEGORY_ID.FIVES,
  CATEGORY_ID.SIXES,
] as const;

export const LOWER_CATEGORY_IDS = [
  CATEGORY_ID.CHOICE,
  CATEGORY_ID.FOUR_OF_A_KIND,
  CATEGORY_ID.FULL_HOUSE,
  CATEGORY_ID.SMALL_STRAIGHT,
  CATEGORY_ID.LARGE_STRAIGHT,
  CATEGORY_ID.YACHT,
] as const;

export const CATEGORY_IDS = [...UPPER_CATEGORY_IDS, ...LOWER_CATEGORY_IDS] as const;

const categoryIdSet = new Set<string>(CATEGORY_IDS);

export function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && categoryIdSet.has(value);
}

export const SPECIAL_COMBINATION = {
  FOUR_OF_A_KIND: CATEGORY_ID.FOUR_OF_A_KIND,
  FULL_HOUSE: CATEGORY_ID.FULL_HOUSE,
  SMALL_STRAIGHT: CATEGORY_ID.SMALL_STRAIGHT,
  LARGE_STRAIGHT: CATEGORY_ID.LARGE_STRAIGHT,
  YACHT: CATEGORY_ID.YACHT,
} as const;

export type SpecialCombination = (typeof SPECIAL_COMBINATION)[keyof typeof SPECIAL_COMBINATION];

export const UPPER_BONUS_THRESHOLD = 63;
export const UPPER_BONUS_SCORE = 35;

export const MAX_TURNS_PER_PLAYER = 12;

export const MAX_ROLLS_PER_TURN = 3;
