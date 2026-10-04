import type { ClientError } from '@repo/game-client-sdk/errors';

export type RecoveryAttemptEvent =
  | Readonly<{ phase: 'started' }>
  | Readonly<{
      phase: 'finished';
      outcome: 'success' | 'failure' | 'cancelled';
      durationMs: number;
      error?: ClientError;
    }>;
