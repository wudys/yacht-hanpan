import { SPECIAL_COMBINATION, type SpecialCombination } from '@repo/yacht-rules';

const ACHIEVEMENT_PRIORITY = [
  SPECIAL_COMBINATION.YACHT,
  SPECIAL_COMBINATION.FOUR_OF_A_KIND,
  SPECIAL_COMBINATION.LARGE_STRAIGHT,
  SPECIAL_COMBINATION.SMALL_STRAIGHT,
  SPECIAL_COMBINATION.FULL_HOUSE,
] as const;

export function selectFeaturedCombination(
  combinations: readonly SpecialCombination[],
): SpecialCombination | null {
  return ACHIEVEMENT_PRIORITY.find((combination) => combinations.includes(combination)) ?? null;
}
