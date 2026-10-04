import { parseCancelRoomRequest, parseCreateRoomRequest } from '@repo/game-protocol/http';
import { parseSocketAuth } from '@repo/game-protocol/socket';
import {
  type CompatibilityContract,
  createCompatibilityContract,
} from '@repo/game-protocol/version';
import { expect, spyOn, test } from 'bun:test';

import { createRoomApplication } from '@/rooms/create-room-application';
import type { RoomApplicationStats } from '@/rooms/room-application';
import { InMemoryRoomTaskQueue } from '@/rooms/scheduling/room-task-queue';
import { createProductionIdentity } from '@/runtime/server-identity';

const contract = createCompatibilityContract('test-release');
const identity = createProductionIdentity();

test('factory stats observe current room resources and removal clears their ownership', async () => {
  let now = 1_000;
  let removalStats: RoomApplicationStats | undefined;
  const application = createRoomApplication({
    clock: { now: () => now },
    expectedContract: contract,
    identity,
    rolls: { execute: async () => ({ ok: false, reason: 'unavailable' }) },
    publishRoomState() {},
    onSchedulerError() {},
    onRoomRemoved: () => {
      removalStats = application.stats();
    },
  });
  try {
    expect(application.stats()).toEqual({
      rooms: { rooms: 0, codes: 0, actionLedgerEntries: 0 },
      pending: 0,
      presence: { rooms: 0, connections: 0 },
      retention: { roomRequests: 0, queueRooms: 0, createAddresses: 0 },
    });
    const created = await application.createRoom(
      parseCreateRoomRequest({
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        operationId: crypto.randomUUID(),
        profile: { characterId: 'navy-bob', variant: false },
      }),
      '192.0.2.1',
    );
    if (!created.ok) throw new Error('create failed');
    expect(
      await application.connectSeat({
        auth: parseSocketAuth({
          roomId: created.data.authority.roomId,
          seatToken: created.data.authority.seatToken,
          contract,
          executionId: crypto.randomUUID(),
          connectionIntent: 'enter',
        }),
        connectionId: 'connection',
        connectedAt: now,
      }),
    ).toMatchObject({ ok: true });
    expect(application.stats()).toMatchObject({
      rooms: { rooms: 1, codes: 1 },
      presence: { rooms: 1, connections: 1 },
      retention: { createAddresses: 1 },
    });
    expect(
      await application.cancelRoom(
        parseCancelRoomRequest({
          roomId: created.data.authority.roomId,
          seatToken: created.data.authority.seatToken,
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(removalStats).toMatchObject({
      rooms: { rooms: 0, codes: 0, actionLedgerEntries: 0 },
      pending: 0,
      presence: { rooms: 0, connections: 0 },
    });
    now = 62_000;
    await application.cleanupRooms();
    expect(application.stats().retention).toEqual({
      roomRequests: 0,
      queueRooms: 0,
      createAddresses: 0,
    });
  } finally {
    application.close();
  }
});

test('factory failure closes acquired queue and scheduler while preserving its original cause', () => {
  const original = new Error('room setup');
  const cleanup = new Error('scheduler close');
  let schedulerCloses = 0;
  const queueClose = spyOn(InMemoryRoomTaskQueue.prototype, 'close');
  const reports: unknown[] = [];
  try {
    expect(() =>
      createRoomApplication(
        {
          clock: { now: () => 1_000 },
          get expectedContract(): CompatibilityContract {
            throw original;
          },
          identity,
          rolls: { execute: async () => ({ ok: false, reason: 'unavailable' }) },
          publishRoomState() {},
          onSchedulerError() {},
          reportUnexpected: (error) => {
            reports.push(error);
            throw new Error('reporter');
          },
        },
        {
          taskScheduler: {
            schedule() {},
            cancel() {},
            close() {
              schedulerCloses += 1;
              throw cleanup;
            },
          },
        },
      ),
    ).toThrow(original);
    expect(queueClose).toHaveBeenCalledTimes(1);
    expect(schedulerCloses).toBe(1);
    expect(reports).toEqual([cleanup]);
  } finally {
    queueClose.mockRestore();
  }
});
