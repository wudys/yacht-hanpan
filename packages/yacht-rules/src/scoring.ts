import {
  CATEGORY_ID,
  type CategoryId,
  SPECIAL_COMBINATION,
  type SpecialCombination,
} from './constants';
import type { Dice, DieFace } from './dice';

export function scoreCategory(categoryId: CategoryId, dice: Dice): number {
  const analysis = classifyDice(dice);

  switch (categoryId) {
    case CATEGORY_ID.ONES:
      return scoreFace(analysis, 1);
    case CATEGORY_ID.TWOS:
      return scoreFace(analysis, 2);
    case CATEGORY_ID.THREES:
      return scoreFace(analysis, 3);
    case CATEGORY_ID.FOURS:
      return scoreFace(analysis, 4);
    case CATEGORY_ID.FIVES:
      return scoreFace(analysis, 5);
    case CATEGORY_ID.SIXES:
      return scoreFace(analysis, 6);
    case CATEGORY_ID.CHOICE:
      return analysis.sum;
    case CATEGORY_ID.FOUR_OF_A_KIND:
      return analysis.combinations[SPECIAL_COMBINATION.FOUR_OF_A_KIND] ? analysis.sum : 0;
    case CATEGORY_ID.FULL_HOUSE:
      return analysis.combinations[SPECIAL_COMBINATION.FULL_HOUSE] ? analysis.sum : 0;
    case CATEGORY_ID.SMALL_STRAIGHT:
      return analysis.combinations[SPECIAL_COMBINATION.SMALL_STRAIGHT] ? 15 : 0;
    case CATEGORY_ID.LARGE_STRAIGHT:
      return analysis.combinations[SPECIAL_COMBINATION.LARGE_STRAIGHT] ? 30 : 0;
    case CATEGORY_ID.YACHT:
      return analysis.combinations[SPECIAL_COMBINATION.YACHT] ? 50 : 0;
    default:
      return assertNever(categoryId);
  }
}

/** All matching categories; enumeration order does not imply display priority. */
export function findSpecialCombinations(dice: Dice): readonly SpecialCombination[] {
  const { combinations } = classifyDice(dice);
  return Object.values(SPECIAL_COMBINATION).filter((combination) => combinations[combination]);
}

function classifyDice(dice: Dice) {
  const histogram: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  let sum = 0;

  for (const face of dice) {
    histogram[face - 1] += 1;
    sum += face;
  }

  const uniqueValues = histogram.flatMap((count, index) =>
    count > 0 ? [(index + 1) as DieFace] : [],
  );
  const groupSizes = histogram.filter((count) => count > 0).sort((a, b) => a - b);

  const maximumGroup = Math.max(...groupSizes);
  const maxConsecutiveRun = consecutiveRun(uniqueValues);

  return {
    sum,
    histogram,
    combinations: {
      [SPECIAL_COMBINATION.YACHT]: maximumGroup === 5,
      [SPECIAL_COMBINATION.FOUR_OF_A_KIND]: maximumGroup >= 4,
      [SPECIAL_COMBINATION.FULL_HOUSE]: groupSizes.join(',') === '2,3',
      [SPECIAL_COMBINATION.SMALL_STRAIGHT]: maxConsecutiveRun >= 4,
      [SPECIAL_COMBINATION.LARGE_STRAIGHT]: maxConsecutiveRun === 5,
    },
  };
}

function consecutiveRun(values: readonly DieFace[]): number {
  let maximum = values.length === 0 ? 0 : 1;
  let current = maximum;

  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === values[index - 1] + 1) {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 1;
    }
  }

  return maximum;
}

function scoreFace(analysis: ReturnType<typeof classifyDice>, face: DieFace): number {
  return analysis.histogram[face - 1] * face;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled category: ${String(value)}`);
}
