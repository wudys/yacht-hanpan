import { describe, expect, test } from 'bun:test';

import type { LogFields, Logger } from '@/runtime/logger';
import { ServerTelemetryMonitor } from '@/runtime/server-telemetry';

describe('ServerTelemetryMonitor', () => {
  test('reports only aggregate bounded runtime state and stops its unref timer', async () => {
    const entries: Array<{ event: string; fields?: LogFields }> = [];
    const logger: Logger = {
      debug: () => undefined,
      error: () => undefined,
      info: (event, fields) => entries.push({ event, fields }),
      warn: () => undefined,
    };
    const monitor = new ServerTelemetryMonitor({
      logger,
      intervalMs: 5,
      roomStats: () => ({
        rooms: { rooms: 2, codes: 2, actionLedgerEntries: 3 },
        pending: 1,
        presence: { rooms: 1, connections: 2 },
        retention: { roomRequests: 2, queueRooms: 1, createAddresses: 2 },
      }),
      transportCounts: () => ({ httpRequests: 1, transports: 3, authenticating: 1 }),
      workerStats: null,
    });

    monitor.start();
    await Bun.sleep(18);
    const snapshot = monitor.snapshot();
    expect(snapshot).toMatchObject({
      rooms: { records: 2, codeIndex: 2, actionLedgerEntries: 3 },
      actions: { pending: 1 },
      presence: { rooms: 1, connections: 2 },
      retention: {
        httpRequests: 1,
        roomRequests: 2,
        queueRooms: 1,
        transports: 3,
        authenticating: 1,
        createAddresses: 2,
      },
      workers: { enabled: false, ready: 0, running: 0, queued: 0, restarts: 0 },
    });
    expect(snapshot.runtime.eventLoopLagMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.runtime.rssBytes).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toMatch(/roomId|seat|token|authority|secret/iu);
    expect(entries.some((entry) => entry.event === 'game.server.telemetry')).toBeTrue();

    monitor.close();
    const loggedBeforeClose = entries.length;
    await Bun.sleep(12);
    expect(entries).toHaveLength(loggedBeforeClose);
  });
});
