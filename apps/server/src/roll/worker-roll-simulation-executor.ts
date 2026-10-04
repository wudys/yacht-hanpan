import type { SimulationInput, SimulationOutcome } from '@repo/dice-simulation/contract';

import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  type RollSimulationExecutor,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import { RollWorkerConnection } from '@/roll/roll-worker-connection';
import { type ErrorReporter, reportUnexpected } from '@/runtime/error-reporter';
import type { Logger } from '@/runtime/logger';

const DEFAULT_JOB_TIMEOUT_MS = 10_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;

interface WorkerRollSimulationExecutorOptions {
  readonly size: number;
  readonly maxQueued: number;
  readonly jobTimeoutMs?: number;
  readonly queueTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly workerUrl?: URL;
  readonly logger?: Logger;
  readonly reportUnexpected?: ErrorReporter;
}

interface PendingJob {
  readonly id: number;
  readonly input: SimulationInput;
  readonly queuedAt: number;
  startedAt: number | null;
  timeout: ReturnType<typeof setTimeout> | null;
  readonly resolve: (result: SimulationOutcome) => void;
  readonly reject: (error: RollSimulationExecutorError) => void;
}

interface WorkerSlot {
  readonly connection: RollWorkerConnection;
  current: PendingJob | null;
}

export class WorkerRollSimulationExecutor implements RollSimulationExecutor {
  readonly #logger: Logger | undefined;
  readonly #reportUnexpected: ErrorReporter | undefined;
  readonly #jobTimeoutMs: number;
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

  public constructor(options: WorkerRollSimulationExecutorOptions) {
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
    this.#size = options.size;
    this.#maxQueued = options.maxQueued;
    this.#jobTimeoutMs = jobTimeoutMs;
    this.#queueTimeoutMs = queueTimeoutMs;
    this.#readyTimeoutMs = readyTimeoutMs;
    this.#logger = options.logger;
    this.#reportUnexpected = options.reportUnexpected;
    this.#workerUrl = options.workerUrl ?? defaultWorkerUrl();
  }

  public start(): Promise<void> {
    if (this.#closing) return Promise.reject(unavailable());
    this.#startPromise ??= this.#startAll();
    return this.#startPromise;
  }

  public execute(input: SimulationInput): Promise<SimulationOutcome> {
    if (!this.#accepting || this.#closing) return Promise.reject(unavailable());
    const idle = this.#slots.find((slot) => slot.connection.ready && slot.current === null);
    if (!idle && this.#queue.length >= this.#maxQueued) {
      this.#logger?.warn('roll_worker_saturated', { queueDepth: this.#queue.length });
      return Promise.reject(
        new RollSimulationExecutorError(ROLL_SIMULATION_EXECUTOR_ERROR_CODE.CAPACITY),
      );
    }

    const job = new Promise<SimulationOutcome>((resolve, reject) => {
      const pending: PendingJob = {
        id: (this.#nextJobId += 1),
        input,
        queuedAt: performance.now(),
        startedAt: null,
        timeout: null,
        resolve,
        reject,
      };
      if (idle) this.#dispatch(idle, pending);
      else {
        this.#queue.push(pending);
        pending.timeout = setTimeout(() => this.#expireQueued(pending), this.#queueTimeoutMs);
        pending.timeout.unref();
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
      onTerminal: (connection, { intentional, warmed }) => {
        const index = this.#slots.findIndex((slot) => slot.connection === connection);
        if (index < 0) return;
        this.#slots.splice(index, 1);
        if (!intentional && !this.#closing && this.#accepting && warmed) {
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
      if (performance.now() - next.queuedAt >= this.#queueTimeoutMs) {
        this.#expireQueued(next);
        continue;
      }
      this.#queue.shift();
      this.#dispatch(idle, next);
    }
  }

  #dispatch(slot: WorkerSlot, job: PendingJob): void {
    clearJobTimeout(job);
    slot.current = job;
    job.startedAt = performance.now();
    job.timeout = setTimeout(() => {
      if (slot.current !== job) return;
      slot.connection.terminate({
        error: new Error('Roll worker job timed out'),
        operation: 'worker.timeout',
      });
      this.#logger?.warn('roll_worker_timed_out', { timeoutMs: this.#jobTimeoutMs });
    }, this.#jobTimeoutMs);
    job.timeout.unref();
    this.#logger?.debug('roll_worker_dispatched', {
      queueDepth: this.#queue.length,
      queueWaitMs: Math.max(0, performance.now() - job.queuedAt),
    });
    void slot.connection.run(job.id, job.input).then(
      (result) => {
        this.#finishJob(slot, job);
        this.#logger?.debug('roll_worker_completed', {
          simulationDurationMs:
            job.startedAt === null ? null : Math.max(0, performance.now() - job.startedAt),
        });
        job.resolve(result);
        this.#dispatchNext();
      },
      () => {
        this.#finishJob(slot, job);
        job.reject(unavailable());
        this.#dispatchNext();
      },
    );
  }

  #finishJob(slot: WorkerSlot, job: PendingJob): void {
    clearJobTimeout(job);
    if (slot.current === job) slot.current = null;
  }

  #expireQueued(job: PendingJob): void {
    const index = this.#queue.indexOf(job);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    clearJobTimeout(job);
    this.#logger?.warn('roll_worker_queue_timed_out', { timeoutMs: this.#queueTimeoutMs });
    job.reject(unavailable());
  }
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
