import type { Clock } from '@/runtime/clock';

export const ADMISSION_OPERATION_KIND = {
  CREATE_ROOM: 'createRoom',
  JOIN_ROOM: 'joinRoom',
} as const;

export const ADMISSION_OPERATION_FAILURE = {
  CAPACITY_EXCEEDED: 'capacityExceeded',
  OPERATION_ID_REUSED: 'operationIdReused',
} as const;

type OperationKind = (typeof ADMISSION_OPERATION_KIND)[keyof typeof ADMISSION_OPERATION_KIND];
type OperationFailure =
  (typeof ADMISSION_OPERATION_FAILURE)[keyof typeof ADMISSION_OPERATION_FAILURE];

interface RegistryEntry {
  readonly fingerprint: string;
  promise: Promise<unknown>;
  expiresAt: number | null;
}

type RunResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: OperationFailure };

export class AdmissionOperationRegistry {
  readonly #clock: Clock;
  readonly #entries: Map<string, RegistryEntry> = new Map();
  readonly #maxEntries: number;
  readonly #ttlMs: number;

  public constructor(options: Readonly<{ clock: Clock; maxEntries: number; ttlMs: number }>) {
    this.#clock = options.clock;
    this.#maxEntries = options.maxEntries;
    this.#ttlMs = options.ttlMs;
  }

  public run<T>(
    kind: OperationKind,
    operationId: string,
    fingerprint: string,
    execute: () => Promise<T>,
    retain: (value: T) => boolean = () => true,
  ): Promise<RunResult<T>> {
    this.prune();
    const key = `${kind}:${operationId}`;
    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve({
          ok: false,
          reason: ADMISSION_OPERATION_FAILURE.OPERATION_ID_REUSED,
        });
      }
      return existing.promise as Promise<RunResult<T>>;
    }

    this.#evictCompletedUntilCapacityAvailable();
    if (this.#entries.size >= this.#maxEntries) {
      return Promise.resolve({
        ok: false,
        reason: ADMISSION_OPERATION_FAILURE.CAPACITY_EXCEEDED,
      });
    }

    const entry: RegistryEntry = {
      fingerprint,
      expiresAt: null,
      promise: Promise.resolve(),
    };
    const promise: Promise<RunResult<T>> = Promise.resolve()
      .then(execute)
      .then(
        (value) => {
          if (retain(value)) {
            entry.expiresAt = this.#clock.now() + this.#ttlMs;
          } else {
            this.#entries.delete(key);
          }
          return { ok: true as const, value };
        },
        (error: unknown) => {
          this.#entries.delete(key);
          throw error;
        },
      );
    entry.promise = promise;
    this.#entries.set(key, entry);
    return promise;
  }

  public prune(): void {
    const now = this.#clock.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.#entries.delete(key);
    }
  }

  public clear(): void {
    this.#entries.clear();
  }

  #evictCompletedUntilCapacityAvailable(): void {
    if (this.#entries.size < this.#maxEntries) return;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt === null) continue;
      this.#entries.delete(key);
      if (this.#entries.size < this.#maxEntries) return;
    }
  }
}
