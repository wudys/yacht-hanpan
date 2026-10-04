import type { CategoryId } from '@repo/yacht-rules';

export type CategoryLabels = Readonly<Record<CategoryId, string>>;

export type PlayerScoreSummaryView = Readonly<{
  label: string;
  imageUrl?: string;
  imageAlt: string;
  total: number;
  upperSubtotal: number;
  upperBonus: number;
}>;

export type ScoreGridMode = 'disabled' | 'viewer-turn' | 'opponent-turn';
