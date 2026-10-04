export const GAME_CLIENT_RETRY_POLICY = {
  acknowledgementTimeoutMs: 3_000,
  maximumAttempts: 3,
  retryDelayMs: 150,
} as const;

export interface RetryPolicy {
  readonly acknowledgementTimeoutMs: number;
  readonly maximumAttempts: number;
  readonly retryDelayMs: number;
}
