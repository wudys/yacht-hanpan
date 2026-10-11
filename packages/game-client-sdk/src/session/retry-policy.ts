export const GAME_CLIENT_RETRY_POLICY = {
  commandResponseTimeoutMs: 45_000,
  retryIntervalMs: 3_150,
  maximumAttempts: 3,
  synchronizationTimeoutMs: 3_000,
} as const;

export interface RetryPolicy {
  readonly retryIntervalMs: number;
  readonly commandResponseTimeoutMs: number;
  readonly maximumAttempts: number;
  readonly synchronizationTimeoutMs: number;
}
