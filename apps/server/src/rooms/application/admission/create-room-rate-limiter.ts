const WINDOW_MS = 60_000;
const IP_ATTEMPT_LIMIT = 10;

export interface CreateRoomRateLimitInput {
  readonly ipAddress: string;
  readonly attemptedAt: number;
}

export type CreateRoomRateLimitResult =
  { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };

export class CreateRoomRateLimiter {
  readonly #attemptsByIp: Map<string, number[]> = new Map<string, number[]>();

  public get trackedAddressCount(): number {
    return this.#attemptsByIp.size;
  }

  public consume(input: CreateRoomRateLimitInput): CreateRoomRateLimitResult {
    this.prune(input.attemptedAt);

    const ipAttempts: number[] = this.#attemptsByIp.get(input.ipAddress) ?? [];
    if (ipAttempts.length >= IP_ATTEMPT_LIMIT) {
      return {
        ok: false,
        retryAfterMs: Math.max(1, ipAttempts[0] + WINDOW_MS - input.attemptedAt),
      };
    }

    ipAttempts.push(input.attemptedAt);
    this.#attemptsByIp.set(input.ipAddress, ipAttempts);
    return { ok: true };
  }

  public prune(attemptedAt: number): void {
    if (!Number.isSafeInteger(attemptedAt) || attemptedAt < 0) {
      throw new Error('Rate-limit timestamp must be a non-negative safe integer');
    }
    const cutoff = attemptedAt - WINDOW_MS;
    for (const [subject, attempts] of this.#attemptsByIp) {
      const active: number[] = attempts.filter((timestamp: number) => timestamp > cutoff);
      if (active.length === 0) this.#attemptsByIp.delete(subject);
      else this.#attemptsByIp.set(subject, active);
    }
  }
}
