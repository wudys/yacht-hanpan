export const MAX_PENDING_ACTIONS_PER_ROOM = 64;
const MAX_WAITERS_PER_ACTION = 8;

export type PendingActionRunResult<Result> =
  | { readonly kind: 'result'; readonly owner: boolean; readonly result: Result }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'saturated' };

interface PendingEntry<Result> {
  readonly fingerprint: string;
  readonly promise: Promise<Result>;
  waiters: number;
}

export class PendingActionRegistry<Result> {
  readonly #byRoom: Map<string, Map<string, PendingEntry<Result>>> = new Map();

  public run(
    roomId: string,
    key: string,
    fingerprint: string,
    execute: () => Promise<Result>,
  ): Promise<PendingActionRunResult<Result>> {
    const room = this.#byRoom.get(roomId) ?? new Map<string, PendingEntry<Result>>();
    const existing = room.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) return Promise.resolve({ kind: 'conflict' });
      if (existing.waiters >= MAX_WAITERS_PER_ACTION) return Promise.resolve({ kind: 'saturated' });
      existing.waiters += 1;
      return existing.promise
        .then((result) => ({ kind: 'result', owner: false, result }) as const)
        .finally(() => {
          existing.waiters -= 1;
        });
    }
    if (room.size >= MAX_PENDING_ACTIONS_PER_ROOM) {
      return Promise.resolve({ kind: 'saturated' });
    }

    const { promise, resolve, reject } = Promise.withResolvers<Result>();
    room.set(key, { fingerprint, promise, waiters: 1 });
    this.#byRoom.set(roomId, room);
    // Register before invoking the owner, but enqueue synchronously so sync and deadline
    // work cannot pass a command whose receivedAt has already been captured.
    try {
      void execute().then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return promise
      .then((result) => ({ kind: 'result', owner: true, result }) as const)
      .finally(() => {
        if (room.get(key)?.promise === promise) room.delete(key);
        if (room.size === 0 && this.#byRoom.get(roomId) === room) this.#byRoom.delete(roomId);
      });
  }

  public count(roomId: string): number {
    return this.#byRoom.get(roomId)?.size ?? 0;
  }

  public clearRoom(roomId: string): void {
    this.#byRoom.delete(roomId);
  }

  public totalCount(): number {
    let total = 0;
    for (const room of this.#byRoom.values()) total += room.size;
    return total;
  }
}
