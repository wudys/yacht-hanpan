import { commandMayPrecede, commandWakeAt, type RoomCommandTime } from '@/rooms/domain/event-time';
import type { RoomId } from '@/rooms/domain/room-model';
import { type Clock, systemClock } from '@/runtime/clock';
import { SystemTaskScheduler, type TaskScheduler } from '@/runtime/task-scheduler';

export type RoomRequestResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly reason: 'capacity' | 'waitExpired' | 'closed' };

export interface RoomTaskQueue {
  readonly runInternal: <Value>(
    roomId: RoomId,
    operation: () => Value | Promise<Value>,
  ) => Promise<Value>;
  readonly runRequest: <Value>(
    roomId: RoomId,
    operation: () => Value | Promise<Value>,
    commandTime?: RoomCommandTime,
  ) => Promise<RoomRequestResult<Value>>;
  readonly clearRoom: (roomId: RoomId) => void;
  readonly close: () => void;
}

interface QueueOptions {
  readonly maxRequests?: number;
  readonly maxRequestsPerRoom?: number;
  readonly requestWaitTimeoutMs?: number;
  readonly clock?: Clock;
  readonly tasks?: Pick<TaskScheduler, 'schedule' | 'cancel'>;
}

export class InMemoryRoomTaskQueue implements RoomTaskQueue {
  readonly #entries: Map<RoomId, QueueEntry> = new Map<RoomId, QueueEntry>();
  readonly #maxRequestsPerRoom: number;
  readonly #maxRequests: number;
  readonly #requestWaitTimeoutMs: number;
  readonly #clock: Clock;
  readonly #tasks: Pick<TaskScheduler, 'schedule' | 'cancel'>;
  readonly #ownedTasks: SystemTaskScheduler | null;
  #pendingRequestCount: number = 0;
  #closed: boolean = false;

  public constructor(options: QueueOptions = {}) {
    this.#maxRequests = options.maxRequests ?? 512;
    this.#maxRequestsPerRoom = options.maxRequestsPerRoom ?? 32;
    this.#requestWaitTimeoutMs = options.requestWaitTimeoutMs ?? 20_000;
    this.#clock = options.clock ?? systemClock;
    if (options.tasks === undefined) {
      this.#ownedTasks = new SystemTaskScheduler(this.#clock);
      this.#tasks = this.#ownedTasks;
    } else {
      this.#ownedTasks = null;
      this.#tasks = options.tasks;
    }
  }

  public get activeRoomCount(): number {
    return this.#entries.size;
  }

  public get pendingRequestCount(): number {
    return this.#pendingRequestCount;
  }

  public runInternal<Value>(
    roomId: RoomId,
    operation: () => Value | Promise<Value>,
  ): Promise<Value> {
    return this.#enqueue(roomId, operation);
  }

  public runRequest<Value>(
    roomId: RoomId,
    operation: () => Value | Promise<Value>,
    commandTime?: RoomCommandTime,
  ): Promise<RoomRequestResult<Value>> {
    if (this.#closed) return Promise.resolve({ ok: false, reason: 'closed' });
    if (
      this.#pendingRequestCount >= this.#maxRequests ||
      (this.#entries.get(roomId)?.requestCount ?? 0) >= this.#maxRequestsPerRoom
    ) {
      return Promise.resolve({ ok: false, reason: 'capacity' });
    }
    return this.#enqueue<RoomRequestResult<Value>>(
      roomId,
      async () => ({ ok: true, value: await operation() }),
      (reason) => ({ ok: false, reason }),
      commandTime,
    );
  }

  public clearRoom(roomId: RoomId): void {
    const entry = this.#entries.get(roomId);
    if (entry === undefined) return;
    this.#tasks.cancel(this.#wakeKey(roomId));
    const remaining: QueueJob[] = [];
    for (const job of entry.jobs) {
      if (job.request) {
        if (job.timer !== null) clearTimeout(job.timer);
        this.#releaseRequest(entry, job);
        job.expire('closed');
      } else {
        remaining.push(job);
      }
    }
    entry.jobs = remaining;
    this.#startNext(roomId, entry);
  }

  public close(): void {
    this.#closed = true;
    for (const roomId of this.#entries.keys()) this.clearRoom(roomId);
    this.#ownedTasks?.close();
  }

  #enqueue<Value>(
    roomId: RoomId,
    operation: () => Value | Promise<Value>,
    expire?: (reason: 'waitExpired' | 'closed') => Value,
    commandTime?: RoomCommandTime,
  ): Promise<Value> {
    const entry: QueueEntry = this.#entries.get(roomId) ?? {
      jobs: [],
      running: false,
      requestCount: 0,
    };
    this.#entries.set(roomId, entry);
    const request = expire !== undefined;
    if (request) {
      entry.requestCount += 1;
      this.#pendingRequestCount += 1;
    }
    return new Promise<Value>((resolve, reject) => {
      const job: QueueJob = {
        request,
        commandTime,
        timer: null,
        deadline: request ? performance.now() + this.#requestWaitTimeoutMs : null,
        expire: (reason) => {
          if (expire !== undefined) resolve(expire(reason));
        },
        execute: async () => {
          try {
            const value = await operation();
            this.#finish(roomId, entry, job);
            resolve(value);
          } catch (error) {
            this.#finish(roomId, entry, job);
            reject(error);
          }
        },
      };
      const beforeForfeit =
        commandTime === undefined
          ? -1
          : entry.jobs.findIndex((queued) => commandMayPrecede(commandTime, queued.commandTime));
      if (beforeForfeit === -1) entry.jobs.push(job);
      else entry.jobs.splice(beforeForfeit, 0, job);
      if (request) {
        job.timer = setTimeout(() => {
          const index = entry.jobs.indexOf(job);
          if (index < 0) return;
          entry.jobs.splice(index, 1);
          this.#releaseRequest(entry, job);
          job.expire('waitExpired');
          this.#startNext(roomId, entry);
        }, this.#requestWaitTimeoutMs);
      }
      this.#startNext(roomId, entry);
    });
  }

  #startNext(roomId: RoomId, entry: QueueEntry): void {
    if (entry.running) return;
    this.#tasks.cancel(this.#wakeKey(roomId));
    let job = entry.jobs[0];
    while (job !== undefined) {
      if (job.deadline !== null && performance.now() >= job.deadline) {
        entry.jobs.shift();
        if (job.timer !== null) clearTimeout(job.timer);
        this.#releaseRequest(entry, job);
        job.expire('waitExpired');
        job = entry.jobs[0];
        continue;
      }
      const wakeAt =
        job.commandTime === undefined ? null : commandWakeAt(job.commandTime, this.#clock.now());
      if (wakeAt !== null) {
        this.#tasks.schedule(this.#wakeKey(roomId), wakeAt, () => {
          if (this.#entries.get(roomId) === entry) this.#startNext(roomId, entry);
        });
        return;
      }
      entry.jobs.shift();
      if (job.timer !== null) clearTimeout(job.timer);
      entry.running = true;
      void Promise.resolve().then(job.execute);
      return;
    }
    this.#entries.delete(roomId);
  }

  #finish(roomId: RoomId, entry: QueueEntry, job: QueueJob): void {
    this.#releaseRequest(entry, job);
    entry.running = false;
    this.#startNext(roomId, entry);
  }

  #releaseRequest(entry: QueueEntry, job: QueueJob): void {
    if (!job.request) return;
    entry.requestCount -= 1;
    this.#pendingRequestCount -= 1;
  }

  #wakeKey(roomId: RoomId): string {
    return `command-quantum:${roomId}`;
  }
}

interface QueueEntry {
  jobs: QueueJob[];
  running: boolean;
  requestCount: number;
}

interface QueueJob {
  readonly request: boolean;
  readonly commandTime: RoomCommandTime | undefined;
  readonly deadline: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  readonly execute: () => Promise<void>;
  readonly expire: (reason: 'waitExpired' | 'closed') => void;
}
