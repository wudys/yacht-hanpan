import { createServer } from 'node:http';

import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomResponse, parseJoinRoomResponse } from '@repo/game-protocol/http';
import { GAME_SOCKET_PATH, parseSyncAck, SOCKET_EVENT } from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { io as createClient } from 'socket.io-client';

import {
  createSocketServerTestFixture,
  createTestRoom,
  emitAck,
  emitAckWithin,
  onceEvent,
  post,
  RELEASE_ID,
  startAdmissionServer,
  within,
} from '@/app/socket-server.test-fixture';
import { startGameServer } from '@/app/start-game-server';
import type { ConnectSeatResult } from '@/rooms/application/connections/connect-seat';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { roomId } from '@/rooms/domain/room-model';
import { RoomApplication } from '@/rooms/room-application';
import { createProductionIdentity } from '@/runtime/server-identity';
import { SocketConnectionLimit } from '@/transport/socket/socket-connection-limit';
import { attachGameSocketServer } from '@/transport/socket/socket-server';

const { servers, clients, connect, startFaultServer, close } = createSocketServerTestFixture();

afterEach(close);

describe('Socket connection lifecycle', () => {
  test('bounds authentication waiters and releases admission after rejection', async () => {
    const gate = Promise.withResolvers<ConnectSeatResult>();
    const entered = Promise.withResolvers<void>();
    const { socketServer, url } = await startAdmissionServer(
      { maxAuthentications: 1 },
      async () => {
        entered.resolve();
        return gate.promise;
      },
    );
    const auth = {
      executionId: crypto.randomUUID(),
      connectionIntent: 'enter',
      roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843e',
      seatToken: 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91',
      contract: createCompatibilityContract(RELEASE_ID),
    };
    const pendingClient = createClient(url, {
      auth,
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
    });
    pendingClient.on('connect_error', () => undefined);
    const rejectedClient = createClient(url, {
      auth,
      autoConnect: false,
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
    });
    try {
      await within(entered.promise, 'authentication entered');
      const rejected = new Promise<Error & { data?: unknown }>((resolve) =>
        rejectedClient.once('connect_error', resolve),
      );
      rejectedClient.connect();
      expect((await within(rejected, 'authentication capacity')).data).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED },
      });
      const finished = onceEvent(pendingClient, 'connect_error');
      gate.resolve({ ok: false, error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} } });
      await within(finished, 'first authentication rejected');
      expect(socketServer.counts().authenticating).toBe(0);
    } finally {
      gate.resolve({ ok: false, error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} } });
      pendingClient.disconnect();
      rejectedClient.disconnect();
      await socketServer.close();
    }
  });

  test('late authentication failure releases a disconnected attempt only once', async () => {
    const entered = Promise.withResolvers<void>();
    const admission = Promise.withResolvers<ConnectSeatResult>();
    const reported = Promise.withResolvers<void>();
    const { socketServer, connectionLimit, url } = await startAdmissionServer(
      {},
      () => {
        entered.resolve();
        return admission.promise;
      },
      () => reported.resolve(),
    );
    const release = spyOn(connectionLimit, 'release');
    const client = createClient(url, {
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
      auth: {
        roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843e',
        seatToken: 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91',
        executionId: crypto.randomUUID(),
        connectionIntent: 'enter',
        contract: createCompatibilityContract(RELEASE_ID),
      },
    });
    try {
      await within(entered.promise, 'authentication entered');
      client.disconnect();
      const deadline = performance.now() + 1_000;
      while (socketServer.counts().authenticating > 0 && performance.now() < deadline)
        await Bun.sleep(1);
      expect(socketServer.counts().authenticating).toBe(0);
      admission.reject(new Error('authentication failed after disconnect'));
      await within(reported.promise, 'late authentication failure handled');
      expect(release).toHaveBeenCalledTimes(1);
      expect(socketServer.counts()).toEqual({ transports: 0, authenticating: 0 });
    } finally {
      client.disconnect();
      admission.resolve({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} },
      });
      await socketServer.close();
      release.mockRestore();
    }
  });

  test('closes an earlier authentication even when its admission result arrives last', async () => {
    const { server } = await startFaultServer();
    const authority = await createTestRoom(server.url, crypto.randomUUID());
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { connectSeat } = RoomApplication.prototype;
    let firstAdmission = true;
    const admission = spyOn(RoomApplication.prototype, 'connectSeat').mockImplementation(
      async function (this: RoomApplication, input: Parameters<RoomApplication['connectSeat']>[0]) {
        const delay = firstAdmission;
        firstAdmission = false;
        const result = await connectSeat.call(this, input);
        if (delay) {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    );
    const auth = {
      roomId: authority.roomId,
      seatToken: authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    };
    const first = createClient(server.url, {
      auth: { ...auth, executionId: crypto.randomUUID(), connectionIntent: 'enter' },
      autoConnect: false,
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
      reconnection: false,
    });
    clients.push(first);
    const outcome = new Promise<string>((resolve) => {
      first.once('connect', () => resolve('connected'));
      first.io.once('open', () => first.io.engine.once('close', () => resolve('closed')));
    });
    try {
      first.connect();
      await within(entered.promise, 'first seat authentication');
      const second = await connect(server.url, auth);
      release.resolve();
      expect(await within(outcome, 'superseded authentication')).toBe('closed');
      expect(first.connected).toBeFalse();
      expect(parseSyncAck(await emitAckWithin(second, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
    } finally {
      release.resolve();
      admission.mockRestore();
    }
  });

  test('replaces the previous seat connection without letting its disconnect mark presence offline', async () => {
    const server = await startGameServer({
      config: {
        allowedOrigins: [],
        trustRenderProxy: false,
        host: '127.0.0.1',
        port: 0,
        releaseId: RELEASE_ID,
      },
    });
    servers.push(server);

    const created = parseCreateRoomResponse(
      (
        await post(`${server.url}/rooms`, {
          clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
          operationId: 'c9ad69ee-7d46-47ed-83df-5ffbd5c1b497',
          profile: { characterId: 'navy-bob', variant: false },
        })
      ).body,
    );
    if (!created.ok) throw new Error('create failed');
    const joined = parseJoinRoomResponse(
      (
        await post(`${server.url}/rooms/${created.data.view.room.roomCode}/join`, {
          clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398440',
          operationId: 'cd7624cc-5085-4147-a0ed-199e2a5ea9a3',
          profile: { characterId: 'blonde-buns', variant: false },
        })
      ).body,
    );
    if (!joined.ok) throw new Error('join failed');

    const auth = {
      roomId: created.data.authority.roomId,
      seatToken: created.data.authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
      executionId: crypto.randomUUID(),
    };
    const first = await connect(server.url, auth);
    const events: string[] = [];
    first.on(SOCKET_EVENT.SESSION_REPLACED, () => events.push('replaced'));
    first.on('disconnect', () => events.push('disconnected'));
    const firstDisconnected = onceEvent(first, 'disconnect');
    const replacement = await connect(server.url, { ...auth, executionId: crypto.randomUUID() });
    await firstDisconnected;
    expect(events).toEqual(['replaced', 'disconnected']);
    await expect(
      connect(server.url, { ...auth, connectionIntent: 'reconnect' }),
    ).rejects.toMatchObject({
      data: { error: { code: PUBLIC_ERROR_CODE.SESSION_REPLACED } },
    });
    expect(replacement.connected).toBeTrue();

    const sync = parseSyncAck(await emitAck(replacement, SOCKET_EVENT.GAME_SYNC));
    expect(sync).toMatchObject({
      ok: true,
      data: {
        presence: {
          seats: [{ status: 'connected' }, { status: 'disconnected' }],
        },
      },
    });
  });

  test('recovers the same execution without sending a terminal replacement event', async () => {
    const { server } = await startFaultServer();
    const authority = await createTestRoom(server.url, crypto.randomUUID());
    const auth = {
      roomId: authority.roomId,
      seatToken: authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
      executionId: crypto.randomUUID(),
    };
    const first = await connect(server.url, auth);
    const events: string[] = [];
    first.on(SOCKET_EVENT.SESSION_REPLACED, () => events.push('replaced'));
    first.on('disconnect', () => events.push('disconnected'));
    const disconnected = onceEvent(first, 'disconnect');
    const recovered = await connect(server.url, { ...auth, connectionIntent: 'reconnect' });
    await within(disconnected, 'old transport closed');
    expect(events).toEqual(['disconnected']);
    expect(parseSyncAck(await emitAckWithin(recovered, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
  });

  test('keeps the active connection when another execution has invalid authority or compatibility', async () => {
    const { server } = await startFaultServer();
    const authority = await createTestRoom(server.url, crypto.randomUUID());
    const auth = {
      roomId: authority.roomId,
      seatToken: authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    };
    const active = await connect(server.url, auth);
    await expect(
      connect(server.url, { ...auth, seatToken: crypto.randomUUID() }),
    ).rejects.toMatchObject({
      data: { error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY } },
    });
    await expect(
      connect(server.url, { ...auth, contract: createCompatibilityContract('old-release') }),
    ).rejects.toMatchObject({
      data: { error: { code: PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH } },
    });
    expect(active.connected).toBeTrue();
    expect(parseSyncAck(await emitAckWithin(active, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
  });

  test.each([
    ['releaseId', 'stale-release'],
    ['gameProtocolVersion', 'game-protocol-v16'],
  ] as const)(
    'returns a strict public connection failure for incompatible %s without changing a waiting room',
    async (field, incompatible) => {
      const repository = new InMemoryRoomRepository();
      const server = await startGameServer({
        repository,
        config: {
          allowedOrigins: [],
          trustRenderProxy: false,
          host: '127.0.0.1',
          port: 0,
          releaseId: RELEASE_ID,
        },
      });
      servers.push(server);
      const authority = await createTestRoom(server.url, crypto.randomUUID());
      const before = repository.getById(roomId(authority.roomId));
      expect(before).toMatchObject({ room: { status: 'waiting' }, match: null, stateVersion: 0 });

      const client = createClient(server.url, {
        autoConnect: false,
        path: GAME_SOCKET_PATH,
        transports: ['websocket'],
        auth: {
          executionId: crypto.randomUUID(),
          connectionIntent: 'enter',
          ...authority,
          contract: { ...createCompatibilityContract(RELEASE_ID), [field]: incompatible },
        },
      });
      clients.push(client);
      const error = await within(
        new Promise<Error & { data?: unknown }>((resolve) => {
          client.once('connect_error', resolve);
          client.connect();
        }),
        'incompatible Socket handshake rejected',
      );
      expect(error.message).toBe('SOCKET_CONNECTION_REJECTED');
      expect(error.data).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH, params: {} },
      });
      expect(JSON.stringify(error.data)).not.toMatch(/token|stack|locale|message/iu);
      expect(repository.getById(roomId(authority.roomId))).toBe(before);
      expect(client.connected).toBeFalse();
    },
  );

  test.each([false, true])(
    'releases cancelled admission with an existing connection: %s',
    async (replaceExisting) => {
      const admission = Promise.withResolvers<ConnectSeatResult>();
      const entered = Promise.withResolvers<void>();
      const admissionReleased = Promise.withResolvers<void>();
      const disconnected = Promise.withResolvers<void>();
      const connectionLimit = new SocketConnectionLimit(2);
      const id = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39843e');
      let connectionId = '';
      let disconnectedConnectionId = '';
      let previousConnectionId: string | null = null;
      const connectedResult = (): ConnectSeatResult => ({
        ok: true,
        data: {
          roomId: id,
          seatIndex: 0,
          previousConnectionId,
          replacedExecution: previousConnectionId !== null,
        },
      });
      const httpServer = createServer();
      const releaseAdmission = connectionLimit.release.bind(connectionLimit);
      const release = spyOn(connectionLimit, 'release').mockImplementation((address, id) => {
        const released = releaseAdmission(address, id);
        if (id === connectionId) admissionReleased.resolve();
        return released;
      });
      const socketServer = attachGameSocketServer(httpServer, {
        allowedOrigins: [],
        clock: { now: () => 2_000 },
        connectionLimit,
        expectedContract: createCompatibilityContract(RELEASE_ID),
        identity: createProductionIdentity(),
        isAcceptingRequests: () => true,
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        resolveClientAddress: () => 'test-address',
        rooms: {
          connectSeat: (input) => {
            if (replaceExisting && previousConnectionId === null) {
              const result = connectedResult();
              previousConnectionId = input.connectionId;
              return Promise.resolve(result);
            }
            connectionId = input.connectionId;
            entered.resolve();
            return admission.promise;
          },
          disconnectSeat: async (input) => {
            if (input.connectionId === connectionId) {
              disconnectedConnectionId = input.connectionId;
              disconnected.resolve();
            }
            return false;
          },
          executeGameCommand: async () => {
            throw new Error('unexpected command');
          },
          syncRoom: async () => {
            throw new Error('unexpected sync');
          },
        },
      });
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address();
      if (address === null || typeof address === 'string')
        throw new Error('missing server address');
      const previous = replaceExisting
        ? await connect(`http://127.0.0.1:${address.port}`, {
            roomId: id,
            seatToken: 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91',
            contract: createCompatibilityContract(RELEASE_ID),
          })
        : null;
      const previousDisconnected =
        previous === null ? Promise.resolve() : onceEvent(previous, 'disconnect');
      const client = createClient(`http://127.0.0.1:${address.port}`, {
        auth: {
          executionId: crypto.randomUUID(),
          connectionIntent: 'enter',
          roomId: id,
          seatToken: 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91',
          contract: createCompatibilityContract(RELEASE_ID),
        },
        path: GAME_SOCKET_PATH,
        transports: ['websocket'],
        reconnection: false,
      });
      try {
        await within(entered.promise, 'admission started');
        expect(connectionLimit.count('test-address')).toBe(replaceExisting ? 2 : 1);
        client.disconnect();
        await within(admissionReleased.promise, 'cancelled admission released');
        expect(connectionLimit.count('test-address')).toBe(replaceExisting ? 1 : 0);
        admission.resolve(connectedResult());
        await within(disconnected.promise, 'cancelled admission cleanup');
        await within(previousDisconnected, 'previous connection replaced');
        expect(disconnectedConnectionId).toBe(connectionId);
        expect(connectionLimit.count('test-address')).toBe(0);
        expect(socketServer.counts()).toEqual({ transports: 0, authenticating: 0 });
        expect(client.connected).toBeFalse();
        if (previous !== null) expect(previous.connected).toBeFalse();
      } finally {
        client.disconnect();
        admission.resolve({
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
        });
        await socketServer.close();
        release.mockRestore();
      }
    },
  );

  test('rejects a connection infrastructure failure without exposing its cause', async () => {
    const { errorEvents, repository, server, reports } = await startFaultServer();
    const original = new TypeError('private repository cause', {
      cause: new RangeError('private cause'),
    });
    const authority = await createTestRoom(server.url, 'a42be26f-39f0-4ac0-860d-16d3f1f38f3c');
    repository.getById = () => {
      throw original;
    };
    const client = createClient(server.url, {
      auth: {
        executionId: crypto.randomUUID(),
        connectionIntent: 'enter',
        roomId: authority.roomId,
        seatToken: authority.seatToken,
        contract: createCompatibilityContract(RELEASE_ID),
      },
      autoConnect: false,
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
    });
    clients.push(client);
    const error = await within(
      new Promise<Error & { data?: unknown }>((resolve) => {
        client.once('connect_error', resolve);
        client.connect();
      }),
      'connection error',
    );

    expect(error.message).toBe('SOCKET_CONNECTION_REJECTED');
    expect(error.data).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
    });
    expect(JSON.stringify(error.data)).not.toMatch(/private|repository|cause|stack|message/iu);
    expect(errorEvents).toEqual(['socket.connection.failed']);
    expect(reports).toEqual([[original, 'socket.connection']]);
    expect(reports[0]?.[0]).toBe(original);
    expect(server.telemetry.snapshot().retention.authenticating).toBe(0);
  });
});
