import type { Clock } from '@/runtime/clock';

const MAX_TIMER_DELAY_MS = 2_147_483_647;
type TaskErrorHandler = (error: unknown) => void;

export interface TaskScheduler {
  schedule(key: string, runAt: number, task: () => void | Promise<void>): void;
  cancel(key: string): void;
  close(): void;
}

export class SystemTaskScheduler implements TaskScheduler {
  readonly #clock: Clock;
  readonly #onError: TaskErrorHandler;
  readonly #timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  #closed: boolean = false;

  public constructor(clock: Clock, onError: TaskErrorHandler = () => undefined) {
    this.#clock = clock;
    this.#onError = onError;
  }

  public schedule(key: string, runAt: number, task: () => void | Promise<void>): void {
    if (this.#closed) return;
    this.cancel(key);
    const delay = Math.max(0, Math.min(runAt - this.#clock.now(), MAX_TIMER_DELAY_MS));
    const timer = setTimeout(() => {
      if (this.#timers.get(key) !== timer) return;
      this.#timers.delete(key);
      void Promise.resolve()
        .then(task)
        .catch((error: unknown) => this.#onError(error));
    }, delay);
    this.#timers.set(key, timer);
  }

  public cancel(key: string): void {
    const timer = this.#timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#timers.delete(key);
  }

  public close(): void {
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}
