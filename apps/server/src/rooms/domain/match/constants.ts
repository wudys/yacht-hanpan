export const TURN_DURATION_MS = 60_000;
export { MAX_ROLLS_PER_TURN, MAX_TURNS_PER_PLAYER } from '@repo/yacht-rules';
export const TIMEOUT_FORFEIT_LIMIT = 3;

export const MATCH_END_REASON = {
  SCORES_COMPLETED: 'scoresCompleted',
  EXPLICIT_FORFEIT: 'explicitForfeit',
  TIMEOUT_LIMIT: 'timeoutLimit',
  CONNECTION_ENDED: 'connectionEnded',
} as const;
