import { Server as HttpServer } from 'node:http';

import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomResponse } from '@repo/game-protocol/http';
import {
  GAME_COMMAND_TYPE,
  GAME_SOCKET_PATH,
  parseCommandAck,
  parseSocketConnectionFailure,
  parseSyncAck,
  SOCKET_EVENT,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Server as SocketIoServer } from 'socket.io';
import { io as createClient } from 'socket.io-client';

import { type GameServer, startGameServer } from '@/app/start-game-server';
import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';
import { RoomApplication } from '@/rooms/room-application';
import type { ErrorReporter } from '@/runtime/error-reporter';
import { SystemTaskScheduler } from '@/runtime/task-scheduler';

const CREATOR_CLIENT_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843d';
const JOINER_CLIENT_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const CREATE_OPERATION_ID = '4ba1e7d4-c077-4b80-b198-9b1f04c182c8';
const JOIN_OPERATION_ID = '888d7ad9-0311-42e8-a245-8e57c3046606';
const servers: GameServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server: GameServer) => server.close()));
});

function config() {
  return {
    allowedOrigins: ['https://yacht.example'],
    trustRenderProxy: false,
    host: '127.0.0.1',
    port: 0,
    releaseId: 'test-release',
  };
}

describe('startGameServer composition', () => {
  test('serves requests and closes its owned worker with a throwing custom logger', async () => {
    const worker = captureOwnedWorker();
    let logs = 0;
    const fail = () => {
      logs += 1;
      throw new Error('diagnostic failure');
    };
    try {
      const server = await startGameServer({
        config: config(),
        logger: { debug: fail, info: fail, warn: fail, error: fail },
      });
      servers.push(server);
      expect((await json(`${server.url}/health/ready`)).status).toBe(200);
      expect(
        (
          await post(`${server.url}/rooms`, {
            clientId: CREATOR_CLIENT_ID,
            operationId: CREATE_OPERATION_ID,
            profile: { characterId: 'navy-bob', variant: false },
          })
        ).status,
      ).toBe(201);
      expect(logs).toBeGreaterThan(0);
      await server.close();
      expect(worker.closeCalls()).toBe(1);
      expect(worker.readyWorkers()).toBe(0);
      await expect(fetch(`${server.url}/health/live`)).rejects.toThrow();
    } finally {
      await worker.cleanup();
    }
  });

  test('shutdown failure still closes the listener, transport and owned worker once', async () => {
    const failure = new Error('scheduler close failure');
    const originalStart = RollSimulationWorkerPool.prototype.start;
    let worker: RollSimulationWorkerPool | undefined;
    const startWorker = spyOn(RollSimulationWorkerPool.prototype, 'start').mockImplementation(
      function (this: RollSimulationWorkerPool) {
        worker = this;
        return originalStart.call(this);
      },
    );
    const closeWorker = spyOn(RollSimulationWorkerPool.prototype, 'close');
    const originalAddress = HttpServer.prototype.address;
    let listener: HttpServer | undefined;
    const address = spyOn(HttpServer.prototype, 'address').mockImplementation(function (
      this: HttpServer,
    ) {
      listener = this;
      return originalAddress.call(this);
    });
    const server = await startGameServer({
      config: config(),
      taskScheduler: {
        schedule() {},
        cancel() {},
        close() {
          throw failure;
        },
      },
    });
    const client = new WebSocket(`${server.url}${GAME_SOCKET_PATH}/?EIO=4&transport=websocket`);
    try {
      await new Promise<void>((resolve, reject) => {
        client.addEventListener('message', () => resolve(), { once: true });
        client.addEventListener('error', () => reject(new Error('transport failure')), {
          once: true,
        });
      });
      const first = server.close();
      expect(server.close()).toBe(first);
      await expect(first).rejects.toBe(failure);
      expect(server.isReady()).toBeFalse();
      await expect(fetch(`${server.url}/health/live`)).rejects.toThrow();
      expect(server.telemetry.snapshot().retention.transports).toBe(0);
      expect(server.telemetry.snapshot().workers.ready).toBe(0);
      expect(closeWorker).toHaveBeenCalledTimes(1);
    } finally {
      client.close();
      if (listener?.listening)
        await new Promise<void>((resolve) => listener?.close(() => resolve()));
      // Recover the owned worker even when the regression fails before reaching its disposer.
      await worker?.close();
      startWorker.mockRestore();
      closeWorker.mockRestore();
      address.mockRestore();
    }
  });

  test('shutdown closes lifecycle admission before HTTP, auth, sync and command application calls', async () => {
    const server = await startGameServer({
      config: config(),
      rolls: { execute: async () => ({ ok: false, reason: 'unavailable' }) },
    });
    servers.push(server);
    const created = parseCreateRoomResponse(
      (
        await post(`${server.url}/rooms`, {
          clientId: CREATOR_CLIENT_ID,
          operationId: CREATE_OPERATION_ID,
          profile: { characterId: 'navy-bob', variant: false },
        })
      ).body,
    );
    if (!created.ok) throw new Error('expected create success');
    const auth = {
      roomId: created.data.authority.roomId,
      seatToken: created.data.authority.seatToken,
      executionId: crypto.randomUUID(),
      connectionIntent: 'enter',
      contract: createCompatibilityContract('test-release'),
    };
    const client = createClient(server.url, {
      autoConnect: false,
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
      auth,
    });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
      client.connect();
    });
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalClose = SocketIoServer.prototype.close;
    const close = spyOn(SocketIoServer.prototype, 'close').mockImplementation(async function (
      this: SocketIoServer,
      callback?: (error?: Error) => void,
    ) {
      entered.resolve();
      await gate.promise;
      return originalClose.call(this, callback);
    });
    const create = spyOn(RoomApplication.prototype, 'createRoom');
    const join = spyOn(RoomApplication.prototype, 'joinRoom');
    const resume = spyOn(RoomApplication.prototype, 'resumeRoom');
    const cancel = spyOn(RoomApplication.prototype, 'cancelRoom');
    const connect = spyOn(RoomApplication.prototype, 'connectSeat');
    const sync = spyOn(RoomApplication.prototype, 'syncRoom');
    const command = spyOn(RoomApplication.prototype, 'executeGameCommand');
    const replacement = createClient(server.url, {
      autoConnect: false,
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
      auth: { ...auth, executionId: crypto.randomUUID() },
    });
    const shutdown = server.close();
    try {
      await entered.promise;
      expect(server.isReady()).toBeFalse();
      expect((await json(`${server.url}/health/live`)).status).toBe(200);
      expect((await json(`${server.url}/health/ready`)).status).toBe(503);
      for (const [path, body] of [
        [
          '/rooms',
          {
            clientId: JOINER_CLIENT_ID,
            operationId: JOIN_OPERATION_ID,
            profile: { characterId: 'navy-bob', variant: false },
          },
        ],
        [
          `/rooms/${created.data.view.room.roomCode}/join`,
          {
            clientId: JOINER_CLIENT_ID,
            operationId: JOIN_OPERATION_ID,
            profile: { characterId: 'navy-bob', variant: false },
          },
        ],
        [`/rooms/${auth.roomId}/resume`, { seatToken: auth.seatToken }],
        [`/rooms/${auth.roomId}/cancel`, { seatToken: auth.seatToken }],
      ] as const) {
        expect(await post(`${server.url}${path}`, body)).toMatchObject({
          status: 500,
          body: { ok: false, error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR } },
        });
      }
      const rejected = new Promise<Error & { data?: unknown }>((resolve) =>
        replacement.once('connect_error', resolve),
      );
      replacement.connect();
      expect(parseSocketConnectionFailure((await rejected).data).error.code).toBe(
        PUBLIC_ERROR_CODE.INTERNAL_ERROR,
      );
      expect(parseSyncAck(await client.emitWithAck(SOCKET_EVENT.GAME_SYNC))).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR },
      });
      expect(
        parseCommandAck(
          await client.emitWithAck(SOCKET_EVENT.GAME_COMMAND, {
            type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
            actionId: crypto.randomUUID(),
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR } });
      expect(
        [create, join, resume, cancel, connect, sync, command].map((spy) => spy.mock.calls.length),
      ).toEqual([0, 0, 0, 0, 0, 0, 0]);
    } finally {
      gate.resolve();
      await shutdown;
      client.disconnect();
      replacement.disconnect();
      close.mockRestore();
      create.mockRestore();
      join.mockRestore();
      resume.mockRestore();
      cancel.mockRestore();
      connect.mockRestore();
      sync.mockRestore();
      command.mockRestore();
    }
  });

  test('listen failure preserves its cause while reporting cleanup failure and closing the worker', async () => {
    const occupied = await startGameServer({
      config: config(),
      rolls: { execute: async () => ({ ok: false, reason: 'unavailable' }) },
    });
    servers.push(occupied);
    const worker = captureOwnedWorker();
    const cleanupFailure = new Error('scheduler cleanup');
    const reports: unknown[] = [];
    let caught: unknown;
    try {
      await startGameServer({
        config: { ...config(), port: Number(new URL(occupied.url).port) },
        taskScheduler: {
          schedule() {},
          cancel() {},
          close() {
            throw cleanupFailure;
          },
        },
        reportUnexpected: (error) => {
          reports.push(error);
          throw new Error('reporter');
        },
      });
    } catch (error) {
      caught = error;
    }
    try {
      expect(caught).toMatchObject({ code: 'EADDRINUSE' });
      expect(reports).toEqual([cleanupFailure]);
      expect(worker.closeCalls()).toBe(1);
      expect(worker.readyWorkers()).toBe(0);
    } finally {
      await worker.cleanup();
    }
  });

  test('maintenance setup failure closes the listening server and owned worker', async () => {
    const failure = new Error('maintenance schedule');
    const worker = captureOwnedWorker();
    const originalEmit = HttpServer.prototype.emit;
    let listener: HttpServer | undefined;
    const emit = spyOn(HttpServer.prototype, 'emit').mockImplementation(function (
      this: HttpServer,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === 'listening') listener = this;
      return originalEmit.call(this, event, ...args);
    });
    let schedulerClosed = 0;
    let caught: unknown;
    try {
      await startGameServer({
        config: config(),
        taskScheduler: {
          schedule() {
            throw failure;
          },
          cancel() {},
          close() {
            schedulerClosed += 1;
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    try {
      expect(caught).toBe(failure);
      expect(listener?.listening).toBeFalse();
      expect(schedulerClosed).toBe(1);
      expect(worker.closeCalls()).toBe(1);
      expect(worker.readyWorkers()).toBe(0);
    } finally {
      if (listener?.listening)
        await new Promise<void>((resolve) => listener?.close(() => resolve()));
      emit.mockRestore();
      await worker.cleanup();
    }
  });

  test('transport setup failure releases the room scheduler and owned worker', async () => {
    const failure = new Error('socket setup');
    const worker = captureOwnedWorker();
    const attach = spyOn(SocketIoServer.prototype, 'attach').mockImplementationOnce(() => {
      throw failure;
    });
    let schedulerClosed = 0;
    let caught: unknown;
    try {
      await startGameServer({
        config: config(),
        taskScheduler: {
          schedule() {},
          cancel() {},
          close() {
            schedulerClosed += 1;
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    try {
      expect(caught).toBe(failure);
      expect(schedulerClosed).toBe(1);
      expect(worker.closeCalls()).toBe(1);
      expect(worker.readyWorkers()).toBe(0);
    } finally {
      attach.mockRestore();
      await worker.cleanup();
    }
  });

  test('reports actual transport retention separately from room presence', async () => {
    const server = await startGameServer({ config: config() });
    servers.push(server);
    const client = new WebSocket(`${server.url}${GAME_SOCKET_PATH}/?EIO=4&transport=websocket`);
    const closed = new Promise<void>((resolve) =>
      client.addEventListener('close', () => resolve(), { once: true }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        client.addEventListener('message', () => resolve(), { once: true });
        client.addEventListener('error', () => reject(new Error('transport failure')), {
          once: true,
        });
      });
      expect(server.telemetry.snapshot()).toMatchObject({
        presence: { connections: 0 },
        retention: { transports: 1, authenticating: 0 },
      });
      client.close();
      await closed;
      const deadline = performance.now() + 1_000;
      while (server.telemetry.snapshot().retention.transports > 0 && performance.now() < deadline) {
        await Bun.sleep(1);
      }
      expect(server.telemetry.snapshot().retention.transports).toBe(0);
    } finally {
      client.close();
    }
  });

  test('reports pending HTTP response retention and releases it on completion', async () => {
    const server = await startGameServer({ config: config() });
    servers.push(server);
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const { createRoom } = RoomApplication.prototype;
    const delayed = spyOn(RoomApplication.prototype, 'createRoom').mockImplementationOnce(
      async function (this: RoomApplication, ...input: Parameters<RoomApplication['createRoom']>) {
        entered.resolve();
        await gate.promise;
        return createRoom.apply(this, input);
      },
    );
    const response = post(`${server.url}/rooms`, {
      clientId: CREATOR_CLIENT_ID,
      operationId: CREATE_OPERATION_ID,
      profile: { characterId: 'navy-bob', variant: false },
    });
    try {
      await entered.promise;
      expect(server.telemetry.snapshot().retention.httpRequests).toBe(1);
      gate.resolve();
      await response;
      expect(server.telemetry.snapshot().retention.httpRequests).toBe(0);
    } finally {
      gate.resolve();
      await response;
      delayed.mockRestore();
    }
  });

  test.each(['::1', '::'])('exposes a usable URL for IPv6 listener %s', async (host) => {
    const server = await startGameServer({ config: { ...config(), host } });
    servers.push(server);

    expect(new URL(server.url).hostname).toBe('[::1]');
    expect(await json(`${server.url}/health/ready`)).toMatchObject({ status: 200 });
  });

  test('readiness follows worker availability while liveness and busy workers remain healthy', async () => {
    const server = await startGameServer({ config: config() });
    servers.push(server);
    const stats = spyOn(RollSimulationWorkerPool.prototype, 'stats');
    try {
      stats.mockReturnValue({ readyWorkers: 0, running: 0, queued: 1, restarts: 1 });
      expect(server.isReady()).toBeFalse();
      expect((await fetch(`${server.url}/health/ready`)).status).toBe(503);
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200);
      stats.mockReturnValue({ readyWorkers: 1, running: 1, queued: 1, restarts: 1 });
      expect(server.isReady()).toBeTrue();
      expect((await fetch(`${server.url}/health/ready`)).status).toBe(200);
    } finally {
      stats.mockRestore();
    }
  });

  test('exposes aggregate in-process telemetry without a public endpoint', async () => {
    const server = await startGameServer({ config: config() });
    servers.push(server);

    const telemetry = server.telemetry.snapshot();
    expect(telemetry).toMatchObject({
      rooms: { records: 0, codeIndex: 0, actionLedgerEntries: 0 },
      actions: { pending: 0 },
      presence: { rooms: 0, connections: 0 },
      workers: { enabled: true, running: 0, queued: 0, restarts: 0 },
    });
    expect(telemetry.workers.ready).toBeGreaterThanOrEqual(1);
    expect((await fetch(`${server.url}/internal/telemetry`)).status).toBe(404);
  });

  test.each([false, true])(
    'reports scheduled task failure once while keeping the scheduler usable, reporter throws: %s',
    async (reporterThrows) => {
      const originalSchedule = SystemTaskScheduler.prototype.schedule;
      let scheduler: SystemTaskScheduler | undefined;
      const scheduled = spyOn(SystemTaskScheduler.prototype, 'schedule').mockImplementation(
        function (
          this: SystemTaskScheduler,
          key: string,
          runAt: number,
          task: () => void | Promise<void>,
        ) {
          scheduler = this;
          originalSchedule.call(this, key, runAt, task);
        },
      );
      const original = new TypeError('private scheduled cause', {
        cause: new RangeError('private cause'),
      });
      const reports: Array<Parameters<ErrorReporter>> = [];
      const observed = Promise.withResolvers<void>();
      try {
        const server = await startGameServer({
          config: config(),
          logger: {
            debug: () => undefined,
            info: () => undefined,
            warn: () => undefined,
            error: () => observed.resolve(),
          },
          rolls: { execute: async () => ({ ok: false, reason: 'unavailable' }) },
          reportUnexpected: (error, operation) => {
            reports.push([error, operation]);
            if (reporterThrows) throw new Error('reporter failure');
          },
        });
        servers.push(server);
        if (scheduler === undefined) throw new Error('missing composition scheduler');
        scheduler.schedule('diagnostic-test', Date.now(), () => {
          throw original;
        });
        await observed.promise;
        expect(reports).toEqual([[original, 'scheduler.task']]);
        expect(reports[0]?.[0]).toBe(original);
        const next = Promise.withResolvers<void>();
        scheduler.schedule('following-task', Date.now(), () => next.resolve());
        await next.promise;
        expect(reports).toHaveLength(1);
      } finally {
        scheduled.mockRestore();
      }
    },
  );
});
async function post(
  url: string,
  body: unknown,
  rawBody: boolean = false,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      rawBody ? body : { contract: createCompatibilityContract('test-release'), body },
    ),
  });
  return { status: response.status, body: await response.json() };
}

async function json(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

function captureOwnedWorker() {
  const originalStart = RollSimulationWorkerPool.prototype.start;
  let worker: RollSimulationWorkerPool | undefined;
  const start = spyOn(RollSimulationWorkerPool.prototype, 'start').mockImplementation(function (
    this: RollSimulationWorkerPool,
  ) {
    worker = this;
    return originalStart.call(this);
  });
  const close = spyOn(RollSimulationWorkerPool.prototype, 'close');
  let closeCalls: number | undefined;
  return {
    closeCalls: () => closeCalls ?? close.mock.calls.length,
    readyWorkers: () => worker?.stats().readyWorkers,
    cleanup: async () => {
      closeCalls = close.mock.calls.length;
      close.mockRestore();
      start.mockRestore();
      await worker?.close();
    },
  };
}
