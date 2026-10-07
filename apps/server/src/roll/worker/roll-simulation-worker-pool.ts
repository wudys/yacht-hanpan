import type { RollCandidateEvaluation, SimulationInput } from '@repo/dice-simulation/contract';

import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  type RollExecutionBudget,
  type RollSimulationExecutor,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import { RollWorkerConnection } from '@/roll/worker/roll-worker-connection';
import { type ErrorReporter, reportUnexpected } from '@/runtime/error-reporter';
import { type Logger, protectLogger } from '@/runtime/logger';

const DEFAULT_JOB_TIMEOUT_MS = 10_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;

interface RollSimulationWorkerPoolOptions {
  readonly size: number;
  readonly maxQueued: number;
  readonly jobTimeoutMs?: number;
  readonly queueTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly monotonicNow?: () => number;
  readonly workerUrl?: URL;
  readonly logger?: Logger;
  readonly reportUnexpected?: ErrorReporter;
}

interface PendingJob {
  readonly id: number;
  readonly input: SimulationInput;
  readonly queuedAt: number;
  readonly deadlineMs: number;
  readonly queueDeadline: StageDeadline;
  finished: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
  readonly resolve: (result: RollCandidateEvaluation) => void;
  readonly reject: (error: RollSimulationExecutorError) => void;
}

interface StageDeadline {
  readonly commandMs: number;
  readonly localMs: number;
  readonly expiresMs: number;
}

interface WorkerSlot {
  readonly connection: RollWorkerConnection;
  current: PendingJob | null;
}

export class RollSimulationWorkerPool implements RollSimulationExecutor {
  readonly #logger: Logger | undefined;
  readonly #reportUnexpected: ErrorReporter | undefined;
  readonly #jobTimeoutMs: number;
  readonly #monotonicNow: () => number;
  readonly #queueTimeoutMs: number;
  readonly #readyTimeoutMs: number;
  readonly #maxQueued: number;
  readonly #size: number;
  readonly #workerUrl: URL;
  readonly #queue: PendingJob[] = [];
  readonly #restartTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  readonly #slots: WorkerSlot[] = [];
  #accepting: boolean = false;
  #closing: boolean = false;
  #nextJobId: number = 0;
  #restarts: number = 0;
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  public constructor(options: RollSimulationWorkerPoolOptions) {
    if (!Number.isInteger(options.size) || options.size < 1) throw new Error('invalid worker size');
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new Error('invalid worker queue capacity');
    }
    const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    if (!Number.isSafeInteger(jobTimeoutMs) || jobTimeoutMs < 1) {
      throw new Error('invalid worker job timeout');
    }
    const queueTimeoutMs = options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
    if (!Number.isSafeInteger(queueTimeoutMs) || queueTimeoutMs < 1) {
      throw new Error('invalid worker queue timeout');
    }
    const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1) {
      throw new Error('invalid worker ready timeout');
    }
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#size = options.size;
    this.#maxQueued = options.maxQueued;
    this.#jobTimeoutMs = jobTimeoutMs;
    this.#queueTimeoutMs = queueTimeoutMs;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#logger = options.logger === undefined ? undefined : protectLogger(options.logger);
    this.#reportUnexpected = options.reportUnexpected;
    this.#workerUrl = options.workerUrl ?? defaultWorkerUrl();
  }

  public start(): Promise<void> {
    if (this.#closing) return Promise.reject(unavailable());
    this.#startPromise ??= this.#startAll();
    return this.#startPromise;
  }

  public execute(
    input: SimulationInput,
    budget: RollExecutionBudget,
  ): Promise<RollCandidateEvaluation> {
    if (!this.#accepting || this.#closing) return Promise.reject(unavailable());
    const now = this.#monotonicNow();
    if (!Number.isFinite(budget.deadlineMs) || now >= budget.deadlineMs) {
      return Promise.reject(unavailable());
    }
    const idle = this.#slots.find((slot) => slot.connection.ready && slot.current === null);
    if (!idle && this.#queue.length >= this.#maxQueued) {
      this.#logger?.warn('roll_worker_saturated', { queueDepth: this.#queue.length });
      return Promise.reject(
        new RollSimulationExecutorError(ROLL_SIMULATION_EXECUTOR_ERROR_CODE.CAPACITY),
      );
    }

    const job = new Promise<RollCandidateEvaluation>((resolve, reject) => {
      const pending: PendingJob = {
        id: (this.#nextJobId += 1),
        input,
        queuedAt: now,
        deadlineMs: budget.deadlineMs,
        queueDeadline: stageDeadline(budget.deadlineMs, now, this.#queueTimeoutMs),
        finished: false,
        timeout: null,
        resolve,
        reject,
      };
      if (idle) this.#dispatch(idle, pending, now);
      else {
        this.#queue.push(pending);
        this.#scheduleQueueTimeout(pending, now);
      }
    });
    return job;
  }

  public stats(): { readyWorkers: number; running: number; queued: number; restarts: number } {
    return {
      readyWorkers: this.#slots.filter((slot) => slot.connection.ready).length,
      running: this.#slots.filter((slot) => slot.current !== null).length,
      queued: this.#queue.length,
      restarts: this.#restarts,
    };
  }

  public close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closing = true;
    this.#accepting = false;
    for (const timer of this.#restartTimers) clearTimeout(timer);
    this.#restartTimers.clear();
    const error = unavailable();
    for (const job of this.#queue.splice(0)) {
      clearJobTimeout(job);
      job.finished = true;
      job.reject(error);
    }
    for (const slot of this.#slots) {
      if (slot.current === null) continue;
      clearJobTimeout(slot.current);
    }
    const workers = this.#slots.splice(0).map((slot) => slot.connection.close());
    this.#closePromise = Promise.allSettled(workers).then(() => undefined);
    return this.#closePromise;
  }

  async #startAll(): Promise<void> {
    try {
      await Promise.all(Array.from({ length: this.#size }, () => this.#spawn()));
      if (this.#closing) throw unavailable();
      this.#accepting = true;
    } catch (error) {
      if (!(error instanceof RollSimulationExecutorError)) {
        reportUnexpected(this.#reportUnexpected, error, 'worker.startup');
      }
      await this.close();
      throw unavailable();
    }
  }

  #spawn(): Promise<void> {
    const connection = new RollWorkerConnection({
      workerUrl: this.#workerUrl,
      readyTimeoutMs: this.#readyTimeoutMs,
      reportUnexpected: this.#reportUnexpected,
      onTerminal: (connection, { reason, warmed }) => {
        const index = this.#slots.findIndex((slot) => slot.connection === connection);
        if (index < 0) return;
        this.#slots.splice(index, 1);
        if (reason !== 'shutdown' && !this.#closing && this.#accepting && warmed) {
          this.#restarts += 1;
          this.#logger?.warn('roll_worker_restarting', { restarts: this.#restarts });
          this.#spawnReplacement();
        }
      },
    });
    const slot: WorkerSlot = { connection, current: null };
    this.#slots.push(slot);
    return connection.start().then(() => this.#dispatchNext());
  }

  #spawnReplacement(): void {
    if (this.#closing || !this.#accepting) return;
    void this.#spawn().catch((error: unknown) => {
      if (!(error instanceof RollSimulationExecutorError)) {
        reportUnexpected(this.#reportUnexpected, error, 'worker.startup');
      }
      this.#logger?.error('roll_worker_restart_failed');
      if (this.#closing || !this.#accepting) return;
      const timer = setTimeout(() => {
        this.#restartTimers.delete(timer);
        this.#spawnReplacement();
      }, 100);
      timer.unref();
      this.#restartTimers.add(timer);
    });
  }

  #dispatchNext(): void {
    if (this.#closing || !this.#accepting) return;
    while (this.#queue.length > 0) {
      const idle = this.#slots.find((slot) => slot.connection.ready && slot.current === null);
      if (!idle) return;
      const next = this.#queue[0];
      if (next === undefined) return;
      const now = this.#monotonicNow();
      if (stageExpiry(next.queueDeadline, now) !== null) {
        this.#expireQueued(next, now);
        continue;
      }
      this.#queue.shift();
      this.#dispatch(idle, next, now);
    }
  }

  #dispatch(slot: WorkerSlot, job: PendingJob, now: number): void {
    clearJobTimeout(job);
    if (now >= job.deadlineMs) {
      job.finished = true;
      job.reject(unavailable());
      return;
    }
    slot.current = job;
    const deadline = stageDeadline(job.deadlineMs, now, this.#jobTimeoutMs);
    this.#scheduleJobTimeout(slot, job, deadline, now);
    this.#logger?.debug('roll_worker_dispatched', {
      queueDepth: this.#queue.length,
      queueWaitMs: Math.max(0, now - job.queuedAt),
    });
    void slot.connection.run(job.id, job.input).then(
      (result) => {
        const completedAt = this.#monotonicNow();
        if (!this.#finishJob(slot, job)) return;
        this.#logger?.debug('roll_worker_completed', {
          jobElapsedMs: Math.max(0, completedAt - now),
        });
        const expiry = stageExpiry(deadline, completedAt);
        if (expiry === 'local') {
          this.#logger?.warn('roll_worker_timed_out', { timeoutMs: this.#jobTimeoutMs });
        }
        if (expiry !== null) job.reject(unavailable());
        else job.resolve(result);
        this.#dispatchNext();
      },
      () => {
        if (!this.#finishJob(slot, job)) return;
        job.reject(unavailable());
        this.#dispatchNext();
      },
    );
  }

  #scheduleJobTimeout(
    slot: WorkerSlot,
    job: PendingJob,
    deadline: StageDeadline,
    now: number,
  ): void {
    job.timeout = setTimeout(() => {
      if (slot.current !== job || job.finished) return;
      const current = this.#monotonicNow();
      const expiry = stageExpiry(deadline, current);
      if (expiry === null) {
        this.#scheduleJobTimeout(slot, job, deadline, current);
      } else if (expiry === 'command') {
        slot.connection.expireBudget();
      } else {
        slot.connection.terminate({
          error: new Error('Roll worker job timed out'),
          operation: 'worker.timeout',
        });
        this.#logger?.warn('roll_worker_timed_out', { timeoutMs: this.#jobTimeoutMs });
      }
    }, deadline.expiresMs - now);
    job.timeout.unref();
  }

  #finishJob(slot: WorkerSlot, job: PendingJob): boolean {
    if (job.finished || slot.current !== job) return false;
    job.finished = true;
    clearJobTimeout(job);
    slot.current = null;
    return true;
  }

  #scheduleQueueTimeout(job: PendingJob, now: number): void {
    job.timeout = setTimeout(
      () => this.#expireQueued(job, this.#monotonicNow()),
      job.queueDeadline.expiresMs - now,
    );
    job.timeout.unref();
  }

  #expireQueued(job: PendingJob, now: number): void {
    const index = this.#queue.indexOf(job);
    if (index < 0) return;
    const expiry = stageExpiry(job.queueDeadline, now);
    if (expiry === null) {
      this.#scheduleQueueTimeout(job, now);
      return;
    }
    this.#queue.splice(index, 1);
    job.finished = true;
    clearJobTimeout(job);
    if (expiry === 'local') {
      this.#logger?.warn('roll_worker_queue_timed_out', { timeoutMs: this.#queueTimeoutMs });
    }
    job.reject(unavailable());
  }
}

function stageDeadline(commandMs: number, startedAt: number, capMs: number): StageDeadline {
  const localMs = startedAt + capMs;
  return { commandMs, localMs, expiresMs: Math.min(commandMs, localMs) };
}

function stageExpiry(deadline: StageDeadline, now: number): 'command' | 'local' | null {
  if (now >= deadline.commandMs) return 'command';
  return now >= deadline.localMs ? 'local' : null;
}

function clearJobTimeout(job: PendingJob): void {
  if (job.timeout === null) return;
  clearTimeout(job.timeout);
  job.timeout = null;
}

function defaultWorkerUrl(): URL {
  return new URL(
    import.meta.url.endsWith('.ts') ? './roll-simulation.worker.ts' : './roll-simulation.worker.js',
    import.meta.url,
  );
}

function unavailable(): RollSimulationExecutorError {
  return new RollSimulationExecutorError(ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE);
}
