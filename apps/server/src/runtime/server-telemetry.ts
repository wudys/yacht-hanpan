import { performance } from 'node:perf_hooks';

import type { RoomApplicationStats } from '@/rooms/room-application';
import type { Logger } from '@/runtime/logger';

export interface ServerTelemetrySnapshot {
  readonly rooms: {
    readonly records: number;
    readonly codeIndex: number;
    readonly actionLedgerEntries: number;
  };
  readonly actions: { readonly pending: number };
  readonly presence: { readonly rooms: number; readonly connections: number };
  readonly retention: {
    readonly httpRequests: number;
    readonly roomRequests: number;
    readonly queueRooms: number;
    readonly transports: number;
    readonly authenticating: number;
    readonly createAddresses: number;
  };
  readonly workers: {
    readonly enabled: boolean;
    readonly ready: number;
    readonly running: number;
    readonly queued: number;
    readonly restarts: number;
  };
  readonly runtime: {
    readonly eventLoopLagMs: number;
    readonly rssBytes: number;
    readonly heapUsedBytes: number;
    readonly externalBytes: number;
  };
}

interface ServerTelemetryMonitorOptions {
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly roomStats: () => RoomApplicationStats;
  readonly transportCounts: () => Pick<
    ServerTelemetrySnapshot['retention'],
    'httpRequests' | 'transports' | 'authenticating'
  >;
  readonly workerStats:
    | (() => {
        readonly readyWorkers: number;
        readonly running: number;
        readonly queued: number;
        readonly restarts: number;
      })
    | null;
}

export class ServerTelemetryMonitor {
  readonly #options: ServerTelemetryMonitorOptions;
  readonly #intervalMs: number;
  #eventLoopLagMs: number = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #expectedAt: number = 0;

  public constructor(options: ServerTelemetryMonitorOptions) {
    this.#options = options;
    this.#intervalMs = options.intervalMs ?? 30_000;
    if (!Number.isFinite(this.#intervalMs) || this.#intervalMs <= 0) {
      throw new Error('invalid telemetry interval');
    }
  }

  public start(): void {
    if (this.#timer !== null) return;
    this.#expectedAt = performance.now() + this.#intervalMs;
    this.#timer = setInterval(() => {
      const now = performance.now();
      this.#eventLoopLagMs = Math.max(0, now - this.#expectedAt);
      this.#expectedAt = now + this.#intervalMs;
      this.#options.logger.info('game.server.telemetry', { ...this.snapshot() });
    }, this.#intervalMs);
    this.#timer.unref();
  }

  public snapshot(): ServerTelemetrySnapshot {
    const application = this.#options.roomStats();
    const room = application.rooms;
    const worker = this.#options.workerStats?.() ?? {
      readyWorkers: 0,
      running: 0,
      queued: 0,
      restarts: 0,
    };
    const memory = process.memoryUsage();
    return {
      rooms: {
        records: room.rooms,
        codeIndex: room.codes,
        actionLedgerEntries: room.actionLedgerEntries,
      },
      actions: { pending: application.pending },
      presence: application.presence,
      retention: { ...application.retention, ...this.#options.transportCounts() },
      workers: {
        enabled: this.#options.workerStats !== null,
        ready: worker.readyWorkers,
        running: worker.running,
        queued: worker.queued,
        restarts: worker.restarts,
      },
      runtime: {
        eventLoopLagMs: this.#eventLoopLagMs,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
      },
    };
  }

  public close(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
