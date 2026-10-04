import {
  CATEGORY_IDS,
  type CategoryId,
  LOWER_CATEGORY_IDS,
  UPPER_BONUS_SCORE,
  UPPER_BONUS_THRESHOLD,
  UPPER_CATEGORY_IDS,
} from './constants';
import type { Dice } from './dice';
import { scoreCategory } from './scoring';

export type Scorecard = Readonly<Partial<Record<CategoryId, number>>>;

export type CategoryPreview =
  | { readonly recorded: true; readonly score: number; readonly selectable: false }
  | {
      readonly recorded: false;
      readonly score: number | null;
      readonly selectable: boolean;
    };

export type CategoryPreviewMap = Readonly<Record<CategoryId, CategoryPreview>>;

export interface ScoreSummary {
  readonly upperSubtotal: number;
  readonly upperBonus: 0 | typeof UPPER_BONUS_SCORE;
  readonly total: number;
}

export function countFilledCategories(scorecard: Scorecard): number {
  return CATEGORY_IDS.filter((categoryId) => Object.hasOwn(scorecard, categoryId)).length;
}

export function previewScores(scorecard: Scorecard, dice: Dice | null): CategoryPreviewMap {
  return Object.fromEntries(
    CATEGORY_IDS.map((categoryId) => {
      if (Object.hasOwn(scorecard, categoryId)) {
        return [
          categoryId,
          {
            recorded: true,
            score: scorecard[categoryId] ?? 0,
            selectable: false,
          },
        ];
      }

      return [
        categoryId,
        {
          recorded: false,
          score: dice === null ? null : scoreCategory(categoryId, dice),
          selectable: dice !== null,
        },
      ];
    }),
  ) as CategoryPreviewMap;
}

function subtotal(scorecard: Scorecard, categoryIds: readonly CategoryId[]): number {
  return categoryIds.reduce((total, categoryId) => total + (scorecard[categoryId] ?? 0), 0);
}

export function summarizeScorecard(scorecard: Scorecard): ScoreSummary {
  const upperSubtotal = subtotal(scorecard, UPPER_CATEGORY_IDS);
  const lowerSubtotal = subtotal(scorecard, LOWER_CATEGORY_IDS);
  const upperBonus = upperSubtotal >= UPPER_BONUS_THRESHOLD ? UPPER_BONUS_SCORE : 0;

  return {
    upperSubtotal,
    upperBonus,
    total: upperSubtotal + upperBonus + lowerSubtotal,
  };
}
