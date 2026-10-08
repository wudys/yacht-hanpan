export type AchievementKind = 'other' | 'yacht';

export const ACHIEVEMENT_SEQUENCE_DURATION_MS = {
  other: 900,
  yacht: 1_980,
} as const satisfies Readonly<Record<AchievementKind, number>>;
