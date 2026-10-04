import { Worker } from 'node:worker_threads';

import type { SimulationInput, SimulationOutcome } from '@repo/dice-simulation/contract';

import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import { ROLL_WORKER_GOLDEN_DIGEST } from '@/roll/roll-worker-golden';
import {
  parseRollWorkerResponse,
  restoreRollWorkerError,
  type RollWorkerRequest,
  type RollWorkerResponse,
} from '@/roll/roll-worker-protocol';
import {
  type ErrorReporter,
  reportUnexpected,
  type ServerErrorOperation,
} from '@/runtime/error-reporter';

export interface RollWorkerTerminal {
  readonly intentional: boolean;
  readonly warmed: boolean;
}

interface RollWorkerFailure {
  readonly error: unknown;
  readonly operation: ServerErrorOperation;
}

interface RollWorkerConnectionOptions {
  readonly workerUrl: URL;
  readonly readyTimeoutMs: number;
  readonly reportUnexpected?: ErrorReporter | undefined;
  readonly onTerminal: (connection: RollWorkerConnection, event: RollWorkerTerminal) => void;
}

interface PendingRun {
  readonly id: number;
  readonly resolve: (result: SimulationOutcome) => void;
  readonly reject: (error: RollSimulationExecutorError) => void;
}

export class RollWorkerConnection {
  readonly #options: RollWorkerConnectionOptions;
  #worker: Worker | null = null;
  #ready: boolean = false;
  #warmed: boolean = false;
  #terminal: boolean = false;
  #intentional: boolean = false;
  #finished: boolean = false;
  #current: PendingRun | null = null;
  #readyTimeout: ReturnType<typeof setTimeout> | null = null;
  #startup: { readonly resolve: () => void; readonly reject: (error: Error) => void } | null = null;
  #startPromise: Promise<void> | null = null;
  #closePromise: Promise<void> | null = null;

  public constructor(options: RollWorkerConnectionOptions) {
    this.#options = options;
  }

  public get ready(): boolean {
    return this.#ready;
  }

  public start(): Promise<void> {
    if (this.#terminal) return Promise.reject(unavailable());
    if (this.#startPromise !== null) return this.#startPromise;
    this.#startPromise = new Promise<void>((resolve, reject) => {
      this.#startup = { resolve, reject };
    });
    try {
      this.#worker = new Worker(this.#options.workerUrl);
      this.#worker.on('message', this.#onMessage);
      this.#worker.on('error', this.#onError);
      this.#worker.on('exit', this.#onExit);
      this.#readyTimeout = setTimeout(() => {
        this.terminate({
          error: new Error('Roll worker readiness timed out'),
          operation: 'worker.timeout',
        });
      }, this.#options.readyTimeoutMs);
      this.#readyTimeout.unref();
    } catch (error) {
      this.#markTerminal({ error, operation: 'worker.startup' });
      this.#finish();
    }
    return this.#startPromise;
  }

  public run(id: number, input: SimulationInput): Promise<SimulationOutcome> {
    const worker = this.#worker;
    if (!this.#ready || this.#current !== null || worker === null) {
      return Promise.reject(unavailable());
    }
    return new Promise<SimulationOutcome>((resolve, reject) => {
      this.#current = { id, resolve, reject };
      try {
        worker.postMessage({ kind: 'run', id, input } satisfies RollWorkerRequest);
      } catch (error) {
        this.terminate({ error, operation: 'worker.job' });
      }
    });
  }

  public terminate(cause?: RollWorkerFailure): void {
    void this.#stop(cause);
  }

  public close(): Promise<void> {
    return this.#stop();
  }

  readonly #onMessage = (value: unknown): void => {
    if (this.#terminal) return;
    let response: RollWorkerResponse;
    try {
      response = parseRollWorkerResponse(value);
    } catch (error) {
      this.terminate({ error, operation: 'worker.response' });
      return;
    }
    if (response.kind === 'startup-error') {
      this.terminate({
        error: restoreRollWorkerError(response.error),
        operation: 'worker.startup',
      });
      return;
    }
    if (response.kind === 'ready') {
      if (response.goldenDigest !== ROLL_WORKER_GOLDEN_DIGEST) {
        this.terminate({
          error: new Error('Roll worker golden mismatch'),
          operation: 'worker.response',
        });
        return;
      }
      this.#ready = true;
      this.#warmed = true;
      this.#clearReadyTimeout();
      this.#startup?.resolve();
      this.#startup = null;
      return;
    }
    const current = this.#current;
    if (!this.#ready || current === null || response.id !== current.id) return;
    this.#current = null;
    if (response.kind === 'result') current.resolve(response.result);
    else {
      reportUnexpected(
        this.#options.reportUnexpected,
        restoreRollWorkerError(response.error),
        'worker.job',
      );
      current.reject(unavailable());
    }
  };

  readonly #onError = (error: Error): void => {
    this.#markTerminal({ error, operation: this.#warmed ? 'worker.exit' : 'worker.startup' });
    // Native errors are followed by exit, which completes the connection's lifetime.
  };

  readonly #onExit = (): void => {
    this.#markTerminal({
      error: new Error('Roll worker exited unexpectedly'),
      operation: this.#warmed ? 'worker.exit' : 'worker.startup',
    });
    this.#finish();
  };

  #markTerminal(cause?: RollWorkerFailure): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#intentional = cause === undefined;
    this.#ready = false;
    this.#clearReadyTimeout();
    this.#startup?.reject(unavailable());
    this.#startup = null;
    this.#current?.reject(unavailable());
    this.#current = null;
    if (cause !== undefined) {
      reportUnexpected(this.#options.reportUnexpected, cause.error, cause.operation);
    }
  }

  #stop(cause?: RollWorkerFailure): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    let resolveClose = () => {};
    this.#closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    this.#markTerminal(cause);
    const finish = (): void => {
      this.#finish();
      resolveClose();
    };
    if (this.#worker === null || this.#finished) finish();
    else {
      try {
        void this.#worker.terminate().then(finish, finish);
      } catch {
        finish();
      }
    }
    return this.#closePromise;
  }

  #finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#clearReadyTimeout();
    this.#worker?.off('message', this.#onMessage);
    this.#worker?.off('error', this.#onError);
    this.#worker?.off('exit', this.#onExit);
    this.#options.onTerminal(this, { intentional: this.#intentional, warmed: this.#warmed });
  }

  #clearReadyTimeout(): void {
    if (this.#readyTimeout === null) return;
    clearTimeout(this.#readyTimeout);
    this.#readyTimeout = null;
  }
}

function unavailable(): RollSimulationExecutorError {
  return new RollSimulationExecutorError(ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE);
}
