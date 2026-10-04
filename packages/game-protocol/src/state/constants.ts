export { CATEGORY_ID, CATEGORY_IDS } from '@repo/yacht-rules';

export const MATCH_END_REASON = {
  SCORES_COMPLETED: 'scoresCompleted',
  EXPLICIT_FORFEIT: 'explicitForfeit',
  TIMEOUT_LIMIT: 'timeoutLimit',
  CONNECTION_ENDED: 'connectionEnded',
} as const;

export const ROOM_STATUS = {
  WAITING: 'waiting',
  PLAYING: 'playing',
  FINISHED: 'finished',
} as const;

export const PRESENCE_STATUS = {
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
} as const;

export const MATCH_STATUS = {
  PLAYING: 'playing',
  FINISHED: 'finished',
} as const;
