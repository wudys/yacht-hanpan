export const TURN_DURATION_MS = 90_000;
export const SCORE_HANDOFF_DURATION_MS = 1_000;
export { MAX_ROLLS_PER_TURN, MAX_TURNS_PER_PLAYER } from '@repo/yacht-rules';
export const TIMEOUT_FORFEIT_LIMIT = 2;

export const MATCH_END_REASON = {
  SCORES_COMPLETED: 'scoresCompleted',
  EXPLICIT_FORFEIT: 'explicitForfeit',
  TIMEOUT_LIMIT: 'timeoutLimit',
  CONNECTION_ENDED: 'connectionEnded',
} as const;
