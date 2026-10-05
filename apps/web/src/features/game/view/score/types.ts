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

export type ScoreDisplayOwner = 'viewer' | 'opponent';

export type ScoreCellDisplay =
  | Readonly<{ state: 'empty'; value: null }>
  | Readonly<{ state: 'recorded' | 'preview'; value: number }>;

export type ScoreCellInput = 'selectable' | 'recorded' | 'disabled';

export type ScoreRecordFeedback = Readonly<{
  identity: string;
  categoryId: CategoryId;
  score: number;
  phase: 'confirming' | 'outgoing' | 'incoming';
  startedAt: number;
  bonusEarned: boolean;
}>;
