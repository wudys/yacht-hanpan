import { Server as HttpServer } from 'node:http';
import { connect } from 'node:net';

import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  parseCancelRoomResponse,
  parseCreateRoomResponse,
  parseJoinRoomResponse,
  parseResumeRoomResponse,
} from '@repo/game-protocol/http';
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
import { Server as SocketIoServer, Socket as ServerSocket } from 'socket.io';
import { io as createClient } from 'socket.io-client';

import { type GameServer, startGameServer } from '@/app/start-game-server';
import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { roomId } from '@/rooms/domain/room-model';
import { RoomApplication } from '@/rooms/room-application';
import type { ErrorReporter } from '@/runtime/error-reporter';
import { createJsonLogger, type LogFields, type Logger } from '@/runtime/logger';
import { parseServerConfig } from '@/runtime/server-config';
import { createProductionIdentity } from '@/runtime/server-identity';
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

  test('rejects legacy flat requests before creating a room', async () => {
    const repository = new InMemoryRoomRepository();
    const server = await startGameServer({ config: config(), repository });
    servers.push(server);
    const response = await post(
      `${server.url}/rooms`,
      {
        clientId: CREATOR_CLIENT_ID,
        operationId: CREATE_OPERATION_ID,
        profile: { characterId: 'navy-bob', variant: false },
      },
      true,
    );
    expect(response.body).toMatchObject({ error: { code: PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH } });
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
  });

  test.each([
    'releaseId',
    'gameProtocolVersion',
    'simulationVersion',
    'timelineSchemaVersion',
    'missing',
  ])(
    'rejects %s incompatibility on every endpoint before facade invocation or mutation',
    async (field) => {
      const repository = new InMemoryRoomRepository();
      const server = await startGameServer({ config: config(), repository });
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
      const before = structuredClone(repository.getById(roomId(created.data.authority.roomId)));
      const contract =
        field === 'missing'
          ? undefined
          : {
              ...createCompatibilityContract('test-release'),
              [field]: 'incompatible-version',
            };
      const routes = [
        {
          method: 'createRoom',
          path: '/rooms',
          body: {
            clientId: JOINER_CLIENT_ID,
            operationId: JOIN_OPERATION_ID,
            profile: { characterId: 'blonde-buns', variant: false },
          },
        },
        {
          method: 'joinRoom',
          path: `/rooms/${created.data.view.room.roomCode}/join`,
          body: {
            clientId: JOINER_CLIENT_ID,
            operationId: JOIN_OPERATION_ID,
            profile: { characterId: 'blonde-buns', variant: false },
          },
        },
        {
          method: 'resumeRoom',
          path: `/rooms/${created.data.authority.roomId}/resume`,
          body: { seatToken: created.data.authority.seatToken },
        },
        {
          method: 'cancelRoom',
          path: `/rooms/${created.data.authority.roomId}/cancel`,
          body: { seatToken: created.data.authority.seatToken },
        },
      ] as const;
      for (const route of routes) {
        const facade = spyOn(RoomApplication.prototype, route.method);
        try {
          const response = await post(
            `${server.url}${route.path}`,
            { contract, body: route.body },
            true,
          );
          expect(response.body).toMatchObject({
            ok: false,
            error: { code: PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH },
          });
          expect(facade).not.toHaveBeenCalled();
          expect(repository.counts()).toEqual({ rooms: 1, codes: 1 });
          expect(repository.getById(roomId(created.data.authority.roomId))).toEqual(before);
        } finally {
          facade.mockRestore();
        }
      }
    },
  );

  test('valid contracts with malformed bodies remain invalid requests on every endpoint', async () => {
    const server = await startGameServer({ config: config() });
    servers.push(server);
    for (const path of [
      '/rooms',
      '/rooms/123456/join',
      `/rooms/${CREATOR_CLIENT_ID}/resume`,
      `/rooms/${CREATOR_CLIENT_ID}/cancel`,
    ]) {
      const response = await post(`${server.url}${path}`, {});
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST } });
    }
  });

  test.each(['::1', '::'])('exposes a usable URL for IPv6 listener %s', async (host) => {
    const server = await startGameServer({ config: { ...config(), host } });
    servers.push(server);

    expect(new URL(server.url).hostname).toBe('[::1]');
    expect(await json(`${server.url}/health/ready`)).toMatchObject({ status: 200 });
  });

  test.each([
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    'http://localhost:4173',
    'http://127.0.0.1:4173',
  ])('allows the local web origin without environment overrides: %s', async (origin) => {
    const server = await startGameServer({ config: { ...parseServerConfig({}), port: 0 } });
    servers.push(server);

    const preflight = await fetch(`${server.url}/rooms`, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
  });

  test('allows only configured browser origins for public room HTTP requests', async () => {
    const server = await startGameServer({ config: config() });
    servers.push(server);

    const preflight = await fetch(`${server.url}/rooms`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://yacht.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://yacht.example');
    expect(preflight.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');

    const denied = await fetch(`${server.url}/rooms`, {
      method: 'OPTIONS',
      headers: { origin: 'https://untrusted.example' },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('publication failure preserves joined authority, operation replay and connection binding', async () => {
    const repository = new InMemoryRoomRepository();
    const reports: unknown[] = [];
    const server = await startGameServer({
      config: config(),
      repository,
      reportUnexpected: (error, operation) => {
        reports.push([error, operation]);
        throw new Error('reporter failure');
      },
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
    const original = new Error('publication failed');
    const publication = spyOn(SocketIoServer.prototype, 'to').mockImplementationOnce(() => {
      throw original;
    });
    const update = spyOn(repository, 'replace');
    const joinBody = {
      clientId: JOINER_CLIENT_ID,
      operationId: JOIN_OPERATION_ID,
      profile: { characterId: 'blonde-buns', variant: false },
    };
    let client: ReturnType<typeof createClient> | undefined;
    try {
      const joined = parseJoinRoomResponse(
        (await post(`${server.url}/rooms/${created.data.view.room.roomCode}/join`, joinBody)).body,
      );
      expect(joined.ok).toBeTrue();
      if (!joined.ok) throw new Error('expected join success');
      const replay = parseJoinRoomResponse(
        (await post(`${server.url}/rooms/${created.data.view.room.roomCode}/join`, joinBody)).body,
      );
      expect(replay.ok && replay.data).toEqual(joined.data);
      expect(update).toHaveBeenCalledTimes(1);
      expect(reports).toEqual([[original, 'room.publish']]);
      const resumed = parseResumeRoomResponse(
        (
          await post(`${server.url}/rooms/${joined.data.authority.roomId}/resume`, {
            seatToken: joined.data.authority.seatToken,
          })
        ).body,
      );
      expect(resumed.ok && resumed.data.view.room.roomId).toBe(joined.data.authority.roomId);
      expect(resumed.ok && resumed.data.seatIndex).toBe(1);
      publication.mockImplementationOnce(() => {
        throw original;
      });
      client = createClient(server.url, {
        autoConnect: false,
        path: GAME_SOCKET_PATH,
        transports: ['websocket'],
        reconnection: false,
        auth: {
          roomId: joined.data.authority.roomId,
          seatToken: joined.data.authority.seatToken,
          executionId: crypto.randomUUID(),
          connectionIntent: 'enter',
          contract: createCompatibilityContract('test-release'),
        },
      });
      await new Promise<void>((resolve, reject) => {
        client!.once('connect', resolve);
        client!.once('connect_error', reject);
        client!.connect();
      });
      const view = parseSyncAck(await client.emitWithAck(SOCKET_EVENT.GAME_SYNC));
      expect(view.ok && view.data.presence.seats[1]?.status).toBe('connected');
      expect(reports).toEqual([
        [original, 'room.publish'],
        [original, 'room.publish'],
      ]);
    } finally {
      client?.disconnect();
      publication.mockRestore();
      update.mockRestore();
    }
  });

  test('room removal publication failure preserves cancellation and repository cleanup', async () => {
    const repository = new InMemoryRoomRepository();
    const reports: unknown[] = [];
    const server = await startGameServer({
      config: config(),
      repository,
      reportUnexpected: (error, operation) => reports.push([error, operation]),
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
    const client = createClient(server.url, {
      autoConnect: false,
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
      auth: {
        roomId: created.data.authority.roomId,
        seatToken: created.data.authority.seatToken,
        executionId: crypto.randomUUID(),
        connectionIntent: 'enter',
        contract: createCompatibilityContract('test-release'),
      },
    });
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
      client.connect();
    });
    const failure = new Error('room disconnect failure');
    const disconnect = spyOn(ServerSocket.prototype, 'disconnect').mockImplementationOnce(() => {
      throw failure;
    });
    try {
      const cancelled = parseCancelRoomResponse(
        (
          await post(`${server.url}/rooms/${created.data.authority.roomId}/cancel`, {
            seatToken: created.data.authority.seatToken,
          })
        ).body,
      );
      expect(cancelled).toMatchObject({ ok: true, data: { cancelled: true } });
      expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
      expect(reports).toEqual([[failure, 'room.publish']]);
    } finally {
      disconnect.mockRestore();
      client.disconnect();
    }
  });

  test('deadline reservation failure remains an HTTP failure outside the publication boundary', async () => {
    const reports: unknown[] = [];
    const server = await startGameServer({
      config: config(),
      reportUnexpected: (error, operation) => reports.push([error, operation]),
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
    const failure = new Error('deadline reservation failed');
    const schedule = spyOn(SystemTaskScheduler.prototype, 'schedule').mockImplementationOnce(() => {
      throw failure;
    });
    try {
      const joined = await post(`${server.url}/rooms/${created.data.view.room.roomCode}/join`, {
        clientId: JOINER_CLIENT_ID,
        operationId: JOIN_OPERATION_ID,
        profile: { characterId: 'blonde-buns', variant: false },
      });
      expect(joined).toMatchObject({
        status: 500,
        body: { ok: false, error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR } },
      });
      expect(reports).toEqual([[failure, 'http.request']]);
    } finally {
      schedule.mockRestore();
    }
  });

  test('replays one authority result for duplicate create and join operations', async () => {
    const repository = new InMemoryRoomRepository();
    let now = 1000;
    const server = await startGameServer({
      config: config(),
      repository,
      clock: { now: () => now },
    });
    servers.push(server);
    const createBody = {
      clientId: CREATOR_CLIENT_ID,
      operationId: CREATE_OPERATION_ID,
      profile: { characterId: 'navy-bob', variant: false },
    };

    const createdResponses = await Promise.all([
      post(`${server.url}/rooms`, createBody),
      post(`${server.url}/rooms`, createBody),
    ]);

    expect(createdResponses.map(({ status }) => status)).toEqual([201, 201]);
    expect(repository.counts()).toEqual({ rooms: 1, codes: 1 });
    const created = parseCreateRoomResponse(createdResponses[0]?.body);
    const replayedCreate = parseCreateRoomResponse(createdResponses[1]?.body);
    if (!created.ok) throw new Error('expected create success');
    if (!replayedCreate.ok) throw new Error('expected replayed create success');
    expect(replayedCreate.data).toEqual(created.data);
    expect(replayedCreate.meta.requestId).not.toBe(created.meta.requestId);
    expect(Number(created.meta.serverTime)).toBe(1000);
    now = 1500;
    const laterReplay = parseCreateRoomResponse(
      (await post(`${server.url}/rooms`, createBody)).body,
    );
    if (!laterReplay.ok) throw new Error('expected later replay success');
    expect(laterReplay.data).toEqual(created.data);
    expect(Number(laterReplay.meta.serverTime)).toBe(1500);

    const joinBody = {
      clientId: JOINER_CLIENT_ID,
      operationId: JOIN_OPERATION_ID,
      profile: { characterId: 'blonde-buns', variant: false },
    };
    const joinedResponses = await Promise.all([
      post(`${server.url}/rooms/${created.data.view.room.roomCode}/join`, joinBody),
      post(`${server.url}/rooms/${created.data.view.room.roomCode}/join`, joinBody),
    ]);

    expect(joinedResponses.map(({ status }) => status)).toEqual([200, 200]);
    const joined = parseJoinRoomResponse(joinedResponses[0]?.body);
    const replayedJoin = parseJoinRoomResponse(joinedResponses[1]?.body);
    if (!joined.ok || !replayedJoin.ok) throw new Error('expected replayed join success');
    expect(replayedJoin.data).toEqual(joined.data);
    expect(replayedJoin.meta.requestId).not.toBe(joined.meta.requestId);
  });

  test('keeps cancelled operation replay separate from later same-client rooms and expiry', async () => {
    const repository = new InMemoryRoomRepository();
    let now = 1_000;
    let maintenance: (() => void | Promise<void>) | undefined;
    const server = await startGameServer({
      config: config(),
      repository,
      clock: { now: () => now },
      taskScheduler: {
        schedule: (key, _at, task) => {
          if (key === 'maintenance:rooms') maintenance = task;
        },
        cancel: () => {},
        close: () => {
          maintenance = undefined;
        },
      },
    });
    servers.push(server);
    const body = {
      clientId: CREATOR_CLIENT_ID,
      operationId: CREATE_OPERATION_ID,
      profile: { characterId: 'navy-bob', variant: false },
    };
    const first = parseCreateRoomResponse((await post(`${server.url}/rooms`, body)).body);
    if (!first.ok) throw new Error('first create failed');
    const conflict = await post(`${server.url}/rooms`, {
      ...body,
      profile: { ...body.profile, variant: true },
    });
    expect(conflict.status).toBe(400);
    expect(conflict.body).toMatchObject({ error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST } });
    const cancelled = await post(`${server.url}/rooms/${first.data.authority.roomId}/cancel`, {
      seatToken: first.data.authority.seatToken,
    });
    expect(cancelled.status).toBe(200);
    const replay = parseCreateRoomResponse((await post(`${server.url}/rooms`, body)).body);
    expect(replay.ok && replay.data).toEqual(first.data);
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
    const second = parseCreateRoomResponse(
      (await post(`${server.url}/rooms`, { ...body, operationId: JOIN_OPERATION_ID })).body,
    );
    if (!second.ok) throw new Error('second create failed');
    now = 61_000;
    const third = parseCreateRoomResponse(
      (
        await post(`${server.url}/rooms`, {
          ...body,
          operationId: '874e5bdd-fe3f-4583-85c3-22de389fae97',
        })
      ).body,
    );
    if (!third.ok) throw new Error('third create failed');
    expect(third.data.authority.roomId).not.toBe(second.data.authority.roomId);
    const wrongToken = await post(`${server.url}/rooms/${third.data.authority.roomId}/resume`, {
      seatToken: second.data.authority.seatToken,
    });
    expect(wrongToken.status).toBe(409);
    now = 301_000;
    expect(maintenance).toBeDefined();
    await maintenance?.();
    expect(repository.counts()).toEqual({ rooms: 1, codes: 1 });
    const resumed = parseResumeRoomResponse(
      (
        await post(`${server.url}/rooms/${third.data.authority.roomId}/resume`, {
          seatToken: third.data.authority.seatToken,
        })
      ).body,
    );
    expect(resumed.ok).toBeTrue();
    await post(`${server.url}/rooms/${second.data.authority.roomId}/cancel`, {
      seatToken: second.data.authority.seatToken,
    });
    expect(repository.counts()).toEqual({ rooms: 1, codes: 1 });
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

  test.each([false, true])(
    'HTTP rate limits honor only the configured Render edge (trusted=%s)',
    async (trustRenderProxy) => {
      const server = await startGameServer({ config: { ...config(), trustRenderProxy } });
      servers.push(server);
      const create = (address: string) =>
        fetch(`${server.url}/rooms`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'cf-connecting-ip': address },
          body: JSON.stringify({
            contract: createCompatibilityContract('test-release'),
            body: {
              clientId: CREATOR_CLIENT_ID,
              operationId: crypto.randomUUID(),
              profile: { characterId: 'navy-bob', variant: false },
            },
          }),
        });
      for (let i = 0; i < 10; i += 1) expect((await create('192.0.2.1')).status).toBe(201);
      expect((await create('192.0.2.1')).status).toBe(429);
      expect((await create('192.0.2.2')).status).toBe(trustRenderProxy ? 201 : 429);
    },
  );

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

  test('serves strict create → waiting resume → join → playing resume flow', async () => {
    const server = await startGameServer({ config: config() });
    servers.push(server);

    expect(await json(`${server.url}/health`)).toEqual({
      status: 200,
      body: { ok: true, runtime: 'bun' },
    });
    expect(await json(`${server.url}/health/live`)).toEqual({
      status: 200,
      body: { ok: true, runtime: 'bun' },
    });
    expect((await json(`${server.url}/health/ready`)).status).toBe(200);

    const createdHttp = await post(`${server.url}/rooms`, {
      clientId: CREATOR_CLIENT_ID,
      operationId: '0af75b79-61f8-4ffd-84e9-cf940b0c6b22',
      profile: { characterId: 'navy-bob', variant: false },
    });
    const created = parseCreateRoomResponse(createdHttp.body);
    expect(createdHttp.status).toBe(201);
    expect(created.ok).toBeTrue();
    if (!created.ok) throw new Error('expected create success');

    const waitingResume = parseResumeRoomResponse(
      (
        await post(`${server.url}/rooms/${created.data.authority.roomId}/resume`, {
          seatToken: created.data.authority.seatToken,
        })
      ).body,
    );
    expect(waitingResume.ok && waitingResume.data.view.game).toBeNull();

    const { roomCode } = created.data.view.room;
    const joinedHttp = await post(`${server.url}/rooms/${roomCode}/join`, {
      clientId: JOINER_CLIENT_ID,
      operationId: 'e957dcf6-765e-44c4-92a4-d4956e6af51f',
      profile: { characterId: 'navy-bob', variant: false },
    });
    const joined = parseJoinRoomResponse(joinedHttp.body);
    expect(joinedHttp.status).toBe(200);
    expect(joined.ok).toBeTrue();
    if (!joined.ok) throw new Error('expected join success');

    const playingResume = parseResumeRoomResponse(
      (
        await post(`${server.url}/rooms/${joined.data.authority.roomId}/resume`, {
          seatToken: joined.data.authority.seatToken,
        })
      ).body,
    );
    expect(playingResume.ok && playingResume.data.view.game?.match.status).toBe('playing');

    await server.close();
    await server.close();
    expect(server.isReady()).toBeFalse();
    servers.pop();
  });

  test('allows separate same-client operations up to the shared IP rate limit', async () => {
    const repository = new InMemoryRoomRepository();
    const server = await startGameServer({
      clock: { now: () => 1_000 },
      config: config(),
      repository,
    });
    servers.push(server);
    const simultaneous = await Promise.all([
      post(`${server.url}/rooms`, {
        clientId: CREATOR_CLIENT_ID,
        operationId: '172f1544-a318-4c52-adc8-cb8a599eec2c',
        profile: { characterId: 'navy-bob', variant: false },
      }),
      post(`${server.url}/rooms`, {
        clientId: CREATOR_CLIENT_ID,
        operationId: '874e5bdd-fe3f-4583-85c3-22de389fae97',
        profile: { characterId: 'navy-bob', variant: false },
      }),
    ]);
    expect(simultaneous.map((response) => response.status).sort()).toEqual([201, 201]);
    expect(repository.counts()).toEqual({ rooms: 2, codes: 2 });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const created = await post(`${server.url}/rooms`, {
        clientId: attempt === 7 ? JOINER_CLIENT_ID : CREATOR_CLIENT_ID,
        operationId: crypto.randomUUID(),
        profile: { characterId: 'navy-bob', variant: false },
      });
      expect(created.status).toBe(201);
    }
    expect(repository.counts()).toEqual({ rooms: 10, codes: 10 });

    const limited = await post(`${server.url}/rooms`, {
      clientId: CREATOR_CLIENT_ID,
      operationId: 'a9af0b5e-e231-436a-8733-1ff04cb9e741',
      profile: { characterId: 'navy-bob', variant: false },
    });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({
      ok: false,
      error: {
        code: PUBLIC_ERROR_CODE.RATE_LIMITED,
        params: { retryAfterMs: 60_000 },
      },
    });
  });

  test.each(['chunked', 'content-length'] as const)(
    'rejects an oversized %s body before EOF and closes the connection',
    async (framing) => {
      const server = await startGameServer({ config: config() });
      servers.push(server);
      const createRoom = spyOn(RoomApplication.prototype, 'createRoom');
      const socket = connect(Number(new URL(server.url).port), '127.0.0.1');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = new Promise<string>((resolve, reject) => {
          let received = '';
          socket.on('data', (chunk) => {
            received += chunk.toString();
          });
          socket.once('error', reject);
          socket.once('close', () => resolve(received));
          timer = setTimeout(() => reject(new Error('oversized request remained open')), 1_000);
        });
        socket.write(
          'POST /rooms HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n' +
            (framing === 'chunked'
              ? 'Transfer-Encoding: chunked\r\n'
              : 'Content-Length: 18000\r\n') +
            'Connection: keep-alive\r\n\r\n',
        );
        if (framing === 'chunked') {
          socket.write('2328\r\n' + 'x'.repeat(9_000) + '\r\n');
          socket.write('2328\r\n' + 'x'.repeat(9_000) + '\r\n');
        }
        const received = await response;
        expect(received).toContain('HTTP/1.1 413 Payload Too Large');
        expect(received).toContain('"code":"INVALID_REQUEST"');
        expect(createRoom).not.toHaveBeenCalled();
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        socket.destroy();
        createRoom.mockRestore();
      }
    },
  );

  test.each([new Error('private exception detail'), 'private exception detail'])(
    'records unexpected HTTP failure without exposing request or exception details: %p',
    async (thrown) => {
      const repository = new InMemoryRoomRepository();
      const lines: string[] = [];
      const reports: Array<Parameters<ErrorReporter>> = [];
      const failure = spyOn(repository, 'createExclusive').mockImplementation(() => {
        throw thrown;
      });
      const server = await startGameServer({
        config: config(),
        repository,
        reportUnexpected: (error, operation) => reports.push([error, operation]),
        logger: createJsonLogger((line) => lines.push(line)),
        rolls: { execute: async () => ({ ok: false, reason: 'unavailable' }) },
      });
      servers.push(server);

      try {
        const response = await post(`${server.url}/rooms`, {
          clientId: CREATOR_CLIENT_ID,
          operationId: CREATE_OPERATION_ID,
          profile: { characterId: 'navy-bob', variant: false },
        });
        const result = parseCreateRoomResponse(response.body);
        expect(response.status).toBe(500);
        expect(result).toMatchObject({
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR },
        });
        expect(repository.counts().rooms).toBe(0);
        expect(reports).toEqual([[thrown, 'http.request']]);
        expect(reports[0]?.[0]).toBe(thrown);
        expect(JSON.stringify(response.body)).not.toMatch(/private|cause|stack|message/u);
        expect(lines.map((line) => JSON.parse(line) as unknown)).toContainEqual({
          level: 'error',
          event: 'http.request.failed',
          requestId: result.meta.requestId,
          error: thrown instanceof Error ? { name: 'Error' } : null,
        });
        expect(lines.join('\n')).not.toMatch(/private exception detail|navy-bob|stack/u);
        expect(lines.join('\n')).not.toContain(CREATOR_CLIENT_ID);
        expect(lines.join('\n')).not.toContain(CREATE_OPERATION_ID);
      } finally {
        failure.mockRestore();
      }
    },
  );

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

  test('rejects malformed transport input without mutation or secret-bearing logs', async () => {
    const repository = new InMemoryRoomRepository();
    const captured: { event: string; fields?: LogFields }[] = [];
    const logger: Logger = {
      debug: (event: string, fields?: LogFields) => captured.push({ event, fields }),
      error: (event: string, fields?: LogFields) => captured.push({ event, fields }),
      info: (event: string, fields?: LogFields) => captured.push({ event, fields }),
      warn: (event: string, fields?: LogFields) => captured.push({ event, fields }),
    };
    const server = await startGameServer({
      config: config(),
      identity: createProductionIdentity(),
      logger,
      repository,
    });
    servers.push(server);

    const wrongType = await fetch(`${server.url}/rooms`, { method: 'POST', body: '{}' });
    expect(wrongType.status).toBe(415);
    const malformed = await fetch(`${server.url}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(400);
    const oversized = await post(`${server.url}/rooms`, { padding: 'x'.repeat(17_000) });
    expect(oversized.status).toBe(413);
    const queried = await post(`${server.url}/rooms?target=other`, {
      clientId: CREATOR_CLIENT_ID,
      operationId: '8f33ef69-fdaf-4be7-9058-3c82c6de48af',
      profile: { characterId: 'navy-bob', variant: false },
    });
    expect(queried.status).toBe(404);
    expect(repository.counts().rooms).toBe(0);

    const wrongTypeBody = wrongType.json() as Promise<unknown>;
    expect(await wrongTypeBody).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST },
    });
    const created = parseCreateRoomResponse(
      (
        await post(`${server.url}/rooms`, {
          clientId: CREATOR_CLIENT_ID,
          operationId: '1545cf1e-df91-4ded-97e5-6c6154f1d419',
          profile: { characterId: 'navy-bob', variant: false },
        })
      ).body,
    );
    if (!created.ok) throw new Error('expected create success');
    const serializedLogs = JSON.stringify(captured);
    expect(serializedLogs).not.toMatch(/padding|authorization|seatToken|stack|17_000/i);
    expect(serializedLogs).not.toContain(created.data.authority.seatToken);
    expect(captured.every((entry) => entry.event === 'http.request.completed')).toBeTrue();
  });
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
