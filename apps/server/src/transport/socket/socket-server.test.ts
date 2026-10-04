import { createServer } from 'node:http';

import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomResponse, parseJoinRoomResponse } from '@repo/game-protocol/http';
import {
  GAME_COMMAND_TYPE,
  GAME_SOCKET_PATH,
  parseCommandAck,
  parseCommittedRoomUpdate,
  parseSyncAck,
  SOCKET_EVENT,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Server as SocketIoServer } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';

import { type GameServer, startGameServer } from '@/app/start-game-server';
import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';
import type { SuccessfulLogicalActionResult } from '@/rooms/application/commands/action-ledger';
import type { ConnectSeatResult } from '@/rooms/application/connections/connect-seat';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { roomId } from '@/rooms/domain/room-model';
import { RoomApplication } from '@/rooms/room-application';
import type { ErrorReporter } from '@/runtime/error-reporter';
import { createProductionIdentity } from '@/runtime/server-identity';
import { SocketConnectionLimit } from '@/transport/socket/socket-connection-limit';
import {
  attachGameSocketServer,
  type AttachGameSocketServerDependencies,
} from '@/transport/socket/socket-server';

const RELEASE_ID = 'test-release';
const servers: GameServer[] = [];
const clients: ClientSocket[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('authoritative Socket server', () => {
  test('reserves a bounded number of unauthenticated transports across concurrent upgrades', async () => {
    const { socketServer, url } = await startAdmissionServer({ maxTransports: 2 });
    const raw = Array.from(
      { length: 3 },
      () => new WebSocket(`${url}${GAME_SOCKET_PATH}/?EIO=4&transport=websocket`),
    );
    try {
      const opened = await Promise.all(
        raw.map((client) =>
          receiveWebSocketMessage(client).then(
            () => true,
            () => false,
          ),
        ),
      );
      expect(opened.filter(Boolean)).toHaveLength(2);
      expect(socketServer.counts().transports).toBe(2);
      const first = raw[opened.findIndex(Boolean)]!;
      const closed = new Promise<void>((resolve) =>
        first.addEventListener('close', () => resolve(), { once: true }),
      );
      first.close();
      await within(closed, 'raw transport closed');
      const replacement = new WebSocket(`${url}${GAME_SOCKET_PATH}/?EIO=4&transport=websocket`);
      raw.push(replacement);
      expect((await receiveWebSocketMessage(replacement)).startsWith('0')).toBeTrue();
    } finally {
      raw.forEach((client) => client.close());
      await socketServer.close();
    }
    expect(socketServer.counts()).toEqual({ transports: 0, authenticating: 0 });
  });

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

  test('closes transports that never authenticate within the connection budget', async () => {
    const { socketServer, url } = await startAdmissionServer({ authenticationTimeoutMs: 20 });
    const client = new WebSocket(`${url}${GAME_SOCKET_PATH}/?EIO=4&transport=websocket`);
    const closed = new Promise<void>((resolve) =>
      client.addEventListener('close', () => resolve(), { once: true }),
    );
    try {
      await receiveWebSocketMessage(client);
      await within(closed, 'authentication deadline');
      expect(socketServer.counts().transports).toBe(0);
    } finally {
      client.close();
      await socketServer.close();
    }
  });

  test('bounds duplicate command ack waiters and releases their slots after completion', async () => {
    const { server } = await startFaultServer();
    const authority = await createTestRoom(server.url, crypto.randomUUID());
    const client = await connect(server.url, {
      roomId: authority.roomId,
      seatToken: authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    });
    const gate = Promise.withResolvers<void>();
    const { executeGameCommand } = RoomApplication.prototype;
    const delayed = spyOn(RoomApplication.prototype, 'executeGameCommand').mockImplementation(
      async function (
        this: RoomApplication,
        input: Parameters<RoomApplication['executeGameCommand']>[0],
      ) {
        await gate.promise;
        return executeGameCommand.call(this, input);
      },
    );
    const command = { type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: crypto.randomUUID() };
    const waiting = Array.from({ length: 8 }, () =>
      emitAck(client, SOCKET_EVENT.GAME_COMMAND, command),
    );
    try {
      const rejected = parseCommandAck(
        await emitAckWithin(client, SOCKET_EVENT.GAME_COMMAND, command),
      );
      expect(rejected).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED },
        meta: { actionId: command.actionId },
      });
    } finally {
      gate.resolve();
      await Promise.all(waiting);
      delayed.mockRestore();
    }
    expect(
      parseCommandAck(await emitAckWithin(client, SOCKET_EVENT.GAME_COMMAND, command)),
    ).toMatchObject({ ok: false, error: { code: PUBLIC_ERROR_CODE.MATCH_FINISHED } });
  });

  test('charges Socket admission to the same trusted edge IP as HTTP', async () => {
    const server = await startGameServer({
      config: {
        allowedOrigins: [],
        trustRenderProxy: true,
        host: '127.0.0.1',
        port: 0,
        releaseId: RELEASE_ID,
      },
    });
    servers.push(server);
    const authority = await createTestRoom(server.url, crypto.randomUUID());
    const acquire = spyOn(SocketConnectionLimit.prototype, 'acquire');
    try {
      const client = await connect(
        server.url,
        {
          roomId: authority.roomId,
          seatToken: authority.seatToken,
          contract: createCompatibilityContract(RELEASE_ID),
        },
        { 'cf-connecting-ip': '192.0.2.7', 'x-forwarded-for': '192.0.2.99' },
      );
      expect(client.connected).toBeTrue();
      expect(acquire).toHaveBeenCalledWith('192.0.2.7', expect.any(String));
    } finally {
      acquire.mockRestore();
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

  test('authenticates seats, scopes snapshots, validates commands, and deduplicates forfeit', async () => {
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
          operationId: '8a870c20-c51d-4ebd-a9fc-e991661fe263',
          profile: { characterId: 'navy-bob', variant: false },
        })
      ).body,
    );
    if (!created.ok) throw new Error('create failed');

    const outsideAuthority = await createTestRoom(server.url, crypto.randomUUID());
    const outsider = await connect(server.url, {
      roomId: outsideAuthority.roomId,
      seatToken: outsideAuthority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    });
    expect(parseSyncAck(await emitAckWithin(outsider, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
    const outsideUpdates: unknown[] = [];
    outsider.on(SOCKET_EVENT.ROOM_STATE, (update: unknown) => outsideUpdates.push(update));

    const creator = await connect(server.url, {
      roomId: created.data.authority.roomId,
      seatToken: created.data.authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    });
    const creatorInitialState = onceEvent(creator, SOCKET_EVENT.ROOM_STATE);

    const joined = parseJoinRoomResponse(
      (
        await post(`${server.url}/rooms/${created.data.view.room.roomCode}/join`, {
          clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398440',
          operationId: '25c2f96c-57cd-4fee-9bb8-a0d4d6c69f10',
          profile: { characterId: 'blonde-buns', variant: false },
        })
      ).body,
    );
    if (!joined.ok) throw new Error('join failed');
    expect(
      Number(parseCommittedRoomUpdate(await creatorInitialState).view.game?.stateVersion),
    ).toBe(1);

    const creatorPresence = waitForPresenceVersion(creator, 3);
    const joiner = await connect(server.url, {
      roomId: joined.data.authority.roomId,
      seatToken: joined.data.authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    });
    expect(
      Number(parseCommittedRoomUpdate(await creatorPresence).view.presence.presenceVersion),
    ).toBe(3);

    const sync = parseSyncAck(await emitAck(joiner, SOCKET_EVENT.GAME_SYNC));
    expect(sync.ok).toBeTrue();
    if (!sync.ok || sync.data.game === null) throw new Error('sync failed');
    expect(sync.data.game.match.status).toBe('playing');
    expect(sync.data.presence.seats.every((seat) => seat.status === 'connected')).toBeTrue();

    const malformed = parseCommandAck(
      await emitAck(joiner, SOCKET_EVENT.GAME_COMMAND, { type: 'private', token: 'secret' }),
    );
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST },
      meta: { actionId: null },
    });

    const actionId = 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d';
    const creatorFinished = onceEvent(creator, SOCKET_EVENT.ROOM_STATE);
    const joinerFinished = onceEvent(joiner, SOCKET_EVENT.ROOM_STATE);
    const forfeit = {
      type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
      actionId,
    };
    const first = parseCommandAck(await emitAck(joiner, SOCKET_EVENT.GAME_COMMAND, forfeit));
    expect(first).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
    expect(parseCommittedRoomUpdate(await creatorFinished).view.game?.match.status).toBe(
      'finished',
    );
    expect(parseCommittedRoomUpdate(await joinerFinished).view.game?.match.status).toBe('finished');

    const duplicate = parseCommandAck(await emitAck(joiner, SOCKET_EVENT.GAME_COMMAND, forfeit));
    expect(duplicate).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
    expect(duplicate.meta.requestId).not.toBe(first.meta.requestId);

    const finishedSync = parseSyncAck(await emitAck(creator, SOCKET_EVENT.GAME_SYNC));
    expect(finishedSync).toMatchObject({
      ok: true,
      data: { game: { stateVersion: 2, match: { status: 'finished' } } },
    });
    // The sync ACK follows earlier outbound updates on the outsider connection.
    const outsideSync = parseSyncAck(await emitAckWithin(outsider, SOCKET_EVENT.GAME_SYNC));
    expect(outsideSync).toMatchObject({
      ok: true,
      data: { room: { roomId: outsideAuthority.roomId }, game: null },
    });
    expect(outsideUpdates).toEqual([]);
  });

  test('broadcasts one authoritative physics artifact and replays it in the duplicate ack', async () => {
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
          operationId: 'a352d145-d218-48d0-b454-2369451f0966',
          profile: { characterId: 'navy-bob', variant: false },
        })
      ).body,
    );
    if (!created.ok) throw new Error('create failed');
    const joined = parseJoinRoomResponse(
      (
        await post(`${server.url}/rooms/${created.data.view.room.roomCode}/join`, {
          clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398440',
          operationId: 'ad4e3b2b-eac3-48e3-bfc9-3d6477013ef5',
          profile: { characterId: 'blonde-buns', variant: false },
        })
      ).body,
    );
    if (!joined.ok) throw new Error('join failed');
    const creator = await connect(server.url, {
      roomId: created.data.authority.roomId,
      seatToken: created.data.authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    });
    const joiner = await connect(server.url, {
      roomId: joined.data.authority.roomId,
      seatToken: joined.data.authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    });
    const sync = parseSyncAck(await emitAck(creator, SOCKET_EVENT.GAME_SYNC));
    if (!sync.ok || sync.data.game === null || sync.data.game.match.status !== 'playing') {
      throw new Error('sync failed');
    }
    expect(parseSyncAck(await emitAckWithin(joiner, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
    const creatorPublications: unknown[] = [];
    const joinerPublications: unknown[] = [];
    creator.on(SOCKET_EVENT.ROOM_STATE, (update: unknown) => creatorPublications.push(update));
    joiner.on(SOCKET_EVENT.ROOM_STATE, (update: unknown) => joinerPublications.push(update));
    const command = {
      type: GAME_COMMAND_TYPE.ROLL_DICE,
      actionId: 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
      turnId: sync.data.game.match.currentTurn.turnId,
    };
    const creatorUpdate = onceEvent(creator, SOCKET_EVENT.ROOM_STATE);
    const joinerUpdate = onceEvent(joiner, SOCKET_EVENT.ROOM_STATE);

    const first = parseCommandAck(await emitAck(creator, SOCKET_EVENT.GAME_COMMAND, command));
    expect(first).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2, roll: {} } } });
    if (!first.ok || !('roll' in first.data.receipt)) {
      throw new Error(`roll ack failed: ${first.ok ? 'missing artifact' : first.error.code}`);
    }
    const seenByCreator = parseCommittedRoomUpdate(await creatorUpdate);
    const seenByJoiner = parseCommittedRoomUpdate(await joinerUpdate);
    const duplicate = parseCommandAck(await emitAck(creator, SOCKET_EVENT.GAME_COMMAND, command));

    expect(seenByCreator).toMatchObject({ type: 'roll:committed', roll: first.data.receipt.roll });
    expect(seenByJoiner).toEqual(seenByCreator);
    expect(duplicate).toMatchObject({
      ok: true,
      data: { receipt: { stateVersion: 2, roll: first.data.receipt.roll } },
    });
    expect(duplicate.meta.requestId).not.toBe(first.meta.requestId);
    // Drain publications on each connection before asserting the duplicate caused no emit.
    for (const client of [creator, joiner]) {
      expect(parseSyncAck(await emitAckWithin(client, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
    }
    expect(creatorPublications).toEqual([seenByCreator]);
    expect(joinerPublications).toEqual([seenByJoiner]);
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

  test('returns a strict public connection failure for an incompatible release', async () => {
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

    const client = createClient(server.url, {
      autoConnect: false,
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
      auth: {
        executionId: crypto.randomUUID(),
        connectionIntent: 'enter',
        roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843e',
        seatToken: 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91',
        contract: createCompatibilityContract('stale-release'),
      },
    });
    clients.push(client);
    const error = await new Promise<Error & { data?: unknown }>((resolve) => {
      client.once('connect_error', resolve);
      client.connect();
    });
    expect(error.message).toBe('SOCKET_CONNECTION_REJECTED');
    expect(error.data).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH, params: {} },
    });
    expect(JSON.stringify(error.data)).not.toMatch(/token|stack|locale|message/iu);
  });

  test('rejects a browser WebSocket handshake from an unconfigured origin', async () => {
    const server = await startGameServer({
      config: {
        allowedOrigins: ['https://yacht.example'],
        trustRenderProxy: false,
        host: '127.0.0.1',
        port: 0,
        releaseId: RELEASE_ID,
      },
    });
    servers.push(server);

    const client = createClient(server.url, {
      autoConnect: false,
      extraHeaders: { origin: 'https://untrusted.example' },
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
    });
    clients.push(client);
    const error = await new Promise<Error>((resolve) => {
      client.once('connect_error', resolve);
      client.connect();
    });
    expect(error.message).toBe('websocket error');
    expect(client.connected).toBeFalse();
  });

  test('ignores sync and commands without callable acknowledgements before application work', async () => {
    const { repository, server } = await startFaultServer();
    const authority = await createTestRoom(server.url, '92c56cc5-8b85-4ca2-80be-f1e0e09e4516');
    const creator = await connect(server.url, {
      roomId: authority.roomId,
      seatToken: authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    });
    const initial = parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC));
    if (!initial.ok) throw new Error('initial sync failed');
    await post(`${server.url}/rooms/${initial.data.room.roomCode}/join`, {
      clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398440',
      operationId: '408d5c67-c39b-4871-8d12-597b99cd6c69',
      profile: { characterId: 'blonde-buns', variant: false },
    });
    const reads = spyOn(repository, 'getById');
    try {
      creator.emit(SOCKET_EVENT.GAME_SYNC);
      creator.emit(SOCKET_EVENT.GAME_SYNC, 'invalid acknowledgement');
      creator.emit(SOCKET_EVENT.GAME_COMMAND, {
        type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
        actionId: 'dd515b91-04b4-48e1-af95-5c0056dbfcfb',
      });
      creator.emit(SOCKET_EVENT.GAME_COMMAND, { type: 'invalid' }, 'invalid acknowledgement');
      const sync = parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC));
      expect(sync.ok && sync.data.game?.match.status).toBe('playing');
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      reads.mockRestore();
    }
  });

  test.each(['success', 'failure'] as const)(
    'bounds concurrent sync requests and releases admission after %s',
    async (completion) => {
      const { server } = await startFaultServer();
      const authority = await createTestRoom(server.url, 'b7793c42-e383-448b-b4d4-132c7a988c03');
      const creator = await connect(server.url, {
        roomId: authority.roomId,
        seatToken: authority.seatToken,
        contract: createCompatibilityContract(RELEASE_ID),
      });
      const initial = parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC));
      if (!initial.ok) throw new Error('initial sync failed');
      const pending = Promise.withResolvers<Awaited<ReturnType<RoomApplication['syncRoom']>>>();
      const entered = Promise.withResolvers<void>();
      const sync = spyOn(RoomApplication.prototype, 'syncRoom').mockImplementationOnce(() => {
        entered.resolve();
        return pending.promise;
      });
      try {
        const first = emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC);
        await within(entered.promise, 'sync started');
        const excess = await Promise.all([
          emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC),
          emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC),
          emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC),
        ]);
        for (const ack of excess) {
          expect(parseSyncAck(ack)).toMatchObject({
            ok: false,
            error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: 1_000 } },
          });
        }
        expect(sync).toHaveBeenCalledTimes(1);
        if (completion === 'success') pending.resolve({ ok: true, data: initial.data });
        else pending.reject(new Error('sync unavailable'));
        expect(parseSyncAck(await first).ok).toBe(completion === 'success');
        expect(parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
        expect(sync).toHaveBeenCalledTimes(2);
      } finally {
        pending.resolve({ ok: true, data: initial.data });
        sync.mockRestore();
      }
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

  test.each([false, true])(
    'acks infrastructure rejections and releases slots even if reporter throws: %s',
    async (reporterThrows) => {
      let resolveDisconnectFailure: () => void = () => undefined;
      const disconnectFailure = new Promise<void>((resolve) => {
        resolveDisconnectFailure = resolve;
      });
      const { errorEvents, repository, server, reports } = await startFaultServer(
        (event) => {
          if (event === 'socket.disconnection.failed') resolveDisconnectFailure();
        },
        () => {
          if (reporterThrows) throw new Error('reporter failure');
        },
      );
      const authority = await createTestRoom(server.url, '67366a68-1669-4d32-8e8d-c58a80fc65f7');
      const creator = await connect(server.url, {
        roomId: authority.roomId,
        seatToken: authority.seatToken,
        contract: createCompatibilityContract(RELEASE_ID),
      });
      const getById = repository.getById.bind(repository);
      const before = getById(roomId(authority.roomId));
      const original = new TypeError('private repository cause', {
        cause: new RangeError('private cause'),
      });
      const fail = () => {
        throw original;
      };
      repository.getById = fail;

      const sync = parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC));
      expect(sync).toMatchObject({ ok: false, error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR } });
      expect(JSON.stringify(sync)).not.toMatch(/private|cause|stack|message/u);
      expect(reports).toEqual([[original, 'socket.sync']]);
      repository.getById = getById;
      expect(parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC)).ok).toBe(true);
      expect(getById(roomId(authority.roomId))).toEqual(before);
      repository.getById = fail;
      const command = parseCommandAck(
        await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, {
          type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
          actionId: 'd9f7870a-5067-45c6-9ae8-e0c7bf572dde',
        }),
      );
      expect(command).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR },
        meta: { actionId: 'd9f7870a-5067-45c6-9ae8-e0c7bf572dde' },
      });
      expect(JSON.stringify(command)).not.toMatch(/private|cause|stack|message/u);
      expect(reports).toEqual([
        [original, 'socket.sync'],
        [original, 'socket.command'],
      ]);
      repository.getById = getById;
      const recovered = parseCommandAck(
        await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, {
          type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
          actionId: crypto.randomUUID(),
        }),
      );
      expect(recovered.ok).toBe(false);
      expect(recovered.ok ? null : recovered.error.code).not.toBe(PUBLIC_ERROR_CODE.INTERNAL_ERROR);
      expect(getById(roomId(authority.roomId))).toEqual(before);
      expect(reports).toHaveLength(2);
      repository.getById = fail;
      creator.disconnect();
      await within(disconnectFailure, 'disconnect failure log');
      expect(reports).toEqual([
        [original, 'socket.sync'],
        [original, 'socket.command'],
        [original, 'socket.disconnect'],
      ]);
      expect(reports.every(([error]) => error === original)).toBe(true);
      expect(server.telemetry.snapshot().retention.authenticating).toBe(0);
      expect(errorEvents).toEqual([
        'socket.sync.failed',
        'socket.command.failed',
        'socket.disconnection.failed',
      ]);
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

  test('invalid outgoing sync releases its slot and invalid committed ACK preserves original action replay', async () => {
    const { server, repository, reports } = await startFaultServer();
    const authority = await createTestRoom(server.url, crypto.randomUUID());
    const room = repository.getById(roomId(authority.roomId));
    if (!room) throw new Error('missing room');
    const joined = parseJoinRoomResponse(
      (
        await post(`${server.url}/rooms/${room.room.code}/join`, {
          clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398440',
          operationId: crypto.randomUUID(),
          profile: { characterId: 'blonde-buns', variant: false },
        })
      ).body,
    );
    if (!joined.ok) throw new Error('join failed');
    const creator = await connect(server.url, {
      roomId: authority.roomId,
      seatToken: authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    });
    const sync = spyOn(RoomApplication.prototype, 'syncRoom').mockResolvedValueOnce({
      ok: true,
      data: null,
    } as unknown as Awaited<ReturnType<RoomApplication['syncRoom']>>);
    let originalReceipt: Omit<SuccessfulLogicalActionResult, 'ok'> | undefined;
    const originalExecute = RoomApplication.prototype.executeGameCommand;
    const execute = spyOn(RoomApplication.prototype, 'executeGameCommand').mockImplementationOnce(
      async function (
        this: RoomApplication,
        input: Parameters<RoomApplication['executeGameCommand']>[0],
      ) {
        const execution = await originalExecute.call(this, input);
        if (!execution.result.ok) throw new Error('expected committed command');
        originalReceipt = execution.result.data.receipt;
        return {
          ...execution,
          result: { ...execution.result, data: null },
        } as unknown as typeof execution;
      },
    );
    try {
      expect(parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC))).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR },
      });
      expect(parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
      const command = { type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: crypto.randomUUID() };
      expect(
        parseCommandAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, command)),
      ).toMatchObject({ ok: false, error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR } });
      const committed = repository.getById(roomId(authority.roomId));
      expect(committed?.stateVersion).toBe(2);
      const duplicate = parseCommandAck(
        await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, command),
      );
      expect(duplicate).toMatchObject({
        ok: true,
        meta: { actionId: command.actionId },
        data: { receipt: { stateVersion: 2 } },
      });
      if (!duplicate.ok || originalReceipt === undefined)
        throw new Error('expected original receipt replay');
      expect(originalReceipt).toEqual(duplicate.data.receipt);
      expect(repository.getById(roomId(authority.roomId))).toBe(committed);
      expect(reports.map(([, operation]) => operation)).toEqual(['socket.sync', 'socket.command']);
      expect(reports.every(([error]) => error instanceof Error)).toBeTrue();
    } finally {
      sync.mockRestore();
      execute.mockRestore();
    }
  });

  test('ACK callback exceptions release sync and command slots in the actual dispatch', async () => {
    let reported = Promise.withResolvers<void>();
    const { server, reports } = await startFaultServer(undefined, () => reported.resolve());
    let transport: SocketIoServer | undefined;
    const originalTo = SocketIoServer.prototype.to;
    const to = spyOn(SocketIoServer.prototype, 'to').mockImplementation(function (
      this: SocketIoServer,
      room: Parameters<SocketIoServer['to']>[0],
    ) {
      transport = this;
      return originalTo.call(this, room);
    });
    const authority = await createTestRoom(server.url, crypto.randomUUID());
    const creator = await connect(server.url, {
      roomId: authority.roomId,
      seatToken: authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    });
    const serverSocket = [...(transport?.sockets.sockets.values() ?? [])][0];
    if (!serverSocket) throw new Error('missing authenticated server socket');
    const dispatchSync = serverSocket.listeners(SOCKET_EVENT.GAME_SYNC)[0];
    const dispatchCommand = serverSocket.listeners(SOCKET_EVENT.GAME_COMMAND)[0];
    if (!dispatchSync || !dispatchCommand) throw new Error('missing game dispatch');
    const original = new Error('ACK callback failed');
    let callbacks = 0;
    const failingAck = (): void => {
      callbacks += 1;
      throw original;
    };
    try {
      dispatchSync(failingAck);
      await within(reported.promise, 'sync transmission failure');
      await Promise.resolve();
      expect(parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
      for (let index = 0; index < 8; index += 1) {
        reported = Promise.withResolvers<void>();
        dispatchCommand(
          { type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: crypto.randomUUID() },
          failingAck,
        );
        await within(reported.promise, 'command transmission failure');
        await Promise.resolve();
      }
      expect(
        parseCommandAck(
          await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, {
            type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
            actionId: crypto.randomUUID(),
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: PUBLIC_ERROR_CODE.MATCH_FINISHED } });
      expect(callbacks).toBe(9);
      expect(reports).toEqual([
        [original, 'socket.sync'],
        ...Array.from({ length: 8 }, (): Parameters<ErrorReporter> => [original, 'socket.command']),
      ]);
    } finally {
      to.mockRestore();
    }
  });

  test('worker recovery allows admission, sync and nonphysical commands while roll failure preserves retry', async () => {
    const { server, repository, reports } = await startFaultServer();
    const stats = spyOn(RollSimulationWorkerPool.prototype, 'stats').mockReturnValue({
      readyWorkers: 0,
      running: 0,
      queued: 0,
      restarts: 1,
    });
    const execute = spyOn(RollSimulationWorkerPool.prototype, 'execute');
    try {
      expect((await fetch(`${server.url}/health/ready`)).status).toBe(503);
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200);
      const createOperation = crypto.randomUUID();
      const authority = await createTestRoom(server.url, createOperation);
      expect(await createTestRoom(server.url, createOperation)).toEqual(authority);
      const waiting = repository.getById(roomId(authority.roomId));
      if (!waiting) throw new Error('missing room');
      const joinBody = {
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398440',
        operationId: crypto.randomUUID(),
        profile: { characterId: 'blonde-buns', variant: false },
      };
      const joined = parseJoinRoomResponse(
        (await post(`${server.url}/rooms/${waiting.room.code}/join`, joinBody)).body,
      );
      if (!joined.ok) throw new Error('join failed');
      const replay = parseJoinRoomResponse(
        (await post(`${server.url}/rooms/${waiting.room.code}/join`, joinBody)).body,
      );
      expect(replay.ok && replay.data).toEqual(joined.data);
      const creator = await connect(server.url, {
        roomId: authority.roomId,
        seatToken: authority.seatToken,
        contract: createCompatibilityContract(RELEASE_ID),
      });
      const joiner = await connect(server.url, {
        roomId: joined.data.authority.roomId,
        seatToken: joined.data.authority.seatToken,
        contract: createCompatibilityContract(RELEASE_ID),
      });
      const sync = parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC));
      expect(sync.ok).toBeTrue();
      if (!sync.ok || sync.data.game?.match.status !== 'playing') throw new Error('sync failed');
      const command = {
        type: GAME_COMMAND_TYPE.ROLL_DICE,
        actionId: crypto.randomUUID(),
        turnId: sync.data.game.match.currentTurn.turnId,
      };
      execute.mockRejectedValueOnce(
        new RollSimulationExecutorError(ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE),
      );
      expect(
        parseCommandAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, command)),
      ).toMatchObject({ ok: false, error: { code: PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE } });
      expect(repository.getById(roomId(authority.roomId))?.stateVersion).toBe(1);
      const rolled = parseCommandAck(
        await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, command),
      );
      expect(rolled).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
      expect(execute).toHaveBeenCalledTimes(2);
      const held = parseCommandAck(
        await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, {
          type: GAME_COMMAND_TYPE.SET_DIE_HELD,
          actionId: crypto.randomUUID(),
          turnId: command.turnId,
          slot: 0,
          isHeld: true,
        }),
      );
      expect(held.ok).toBeTrue();
      const scored = parseCommandAck(
        await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, {
          type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
          actionId: crypto.randomUUID(),
          turnId: command.turnId,
          categoryId: 'ones',
        }),
      );
      expect(scored.ok).toBeTrue();
      const duplicate = parseCommandAck(
        await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, command),
      );
      expect(duplicate.ok && duplicate.data.receipt).toEqual(rolled.ok && rolled.data.receipt);
      expect(execute).toHaveBeenCalledTimes(2);
      const forfeited = parseCommandAck(
        await emitAckWithin(joiner, SOCKET_EVENT.GAME_COMMAND, {
          type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
          actionId: crypto.randomUUID(),
        }),
      );
      expect(forfeited.ok && forfeited.data.view.game?.match.status).toBe('finished');
      expect(reports).toEqual([]);
      expect((await fetch(`${server.url}/health/ready`)).status).toBe(503);
    } finally {
      execute.mockRestore();
      stats.mockRestore();
    }
  });

  test('normal malformed and worker-recovery Socket results do not synthesize issues', async () => {
    const { server, reports } = await startFaultServer();
    const authority = await createTestRoom(server.url, crypto.randomUUID());
    await expect(
      connect(server.url, {
        roomId: authority.roomId,
        seatToken: 'invalid',
        contract: createCompatibilityContract(RELEASE_ID),
      }),
    ).rejects.toThrow('SOCKET_CONNECTION_REJECTED');
    const creator = await connect(server.url, {
      roomId: authority.roomId,
      seatToken: authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    });
    expect(
      parseCommandAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, {})),
    ).toMatchObject({ ok: false, error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST } });
    const stats = spyOn(RollSimulationWorkerPool.prototype, 'stats').mockReturnValue({
      readyWorkers: 0,
      running: 0,
      queued: 0,
      restarts: 0,
    });
    try {
      expect(parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC))).toMatchObject({
        ok: true,
      });
      expect(
        parseCommandAck(
          await emitAckWithin(creator, SOCKET_EVENT.GAME_COMMAND, {
            type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
            actionId: crypto.randomUUID(),
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: PUBLIC_ERROR_CODE.MATCH_FINISHED } });
      expect(reports).toEqual([]);
    } finally {
      stats.mockRestore();
    }
    expect(parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC)).ok).toBe(true);
    expect(reports).toEqual([]);
  });

  test('advertises the canonical heartbeat values in the Engine.IO opening packet', async () => {
    const server = await startGameServer({
      config: {
        allowedOrigins: ['https://yacht.example'],
        trustRenderProxy: false,
        host: '127.0.0.1',
        port: 0,
        releaseId: RELEASE_ID,
      },
    });
    servers.push(server);

    const client = new WebSocket(`${server.url}${GAME_SOCKET_PATH}/?EIO=4&transport=websocket`, {
      headers: { origin: 'https://yacht.example' },
    });
    try {
      const rawPacket = await receiveWebSocketMessage(client);
      expect(rawPacket.charAt(0)).toBe('0');
      const packet = parseEngineIoOpenPacket(rawPacket.slice(1));
      expect(packet.pingInterval).toBe(20_000);
      expect(packet.pingTimeout).toBe(15_000);
    } finally {
      client.close();
    }
  });
});

async function startAdmissionServer(
  limits: Pick<
    AttachGameSocketServerDependencies,
    'maxTransports' | 'maxAuthentications' | 'authenticationTimeoutMs'
  >,
  connectSeat: AttachGameSocketServerDependencies['rooms']['connectSeat'] = async () => ({
    ok: false,
    error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} },
  }),
  reportUnexpected?: ErrorReporter,
) {
  const httpServer = createServer();
  const connectionLimit = new SocketConnectionLimit();
  const socketServer = attachGameSocketServer(httpServer, {
    ...limits,
    allowedOrigins: [],
    clock: { now: () => Date.now() },
    connectionLimit,
    reportUnexpected,
    expectedContract: createCompatibilityContract(RELEASE_ID),
    identity: createProductionIdentity(),
    isAcceptingRequests: () => true,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    resolveClientAddress: () => 'test-address',
    rooms: {
      connectSeat,
      disconnectSeat: async () => false,
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
  if (address === null || typeof address === 'string') throw new Error('missing server address');
  return { socketServer, connectionLimit, url: `http://127.0.0.1:${address.port}` };
}

async function connect(
  url: string,
  auth: object,
  extraHeaders?: Record<string, string>,
): Promise<ClientSocket> {
  const client = createClient(url, {
    extraHeaders,
    auth: { executionId: crypto.randomUUID(), connectionIntent: 'enter', ...auth },
    autoConnect: false,
    path: GAME_SOCKET_PATH,
    transports: ['websocket'],
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
    client.connect();
  });
  return client;
}

async function startFaultServer(
  onError?: (event: string) => void,
  onReport?: ErrorReporter,
): Promise<{
  readonly errorEvents: string[];
  readonly reports: Array<Parameters<ErrorReporter>>;
  readonly repository: InMemoryRoomRepository;
  readonly server: GameServer;
}> {
  const repository = new InMemoryRoomRepository();
  const errorEvents: string[] = [];
  const reports: Array<Parameters<ErrorReporter>> = [];
  const server = await startGameServer({
    config: {
      allowedOrigins: [],
      trustRenderProxy: false,
      host: '127.0.0.1',
      port: 0,
      releaseId: RELEASE_ID,
    },
    logger: {
      debug: () => undefined,
      error: (event) => {
        errorEvents.push(event);
        onError?.(event);
      },
      info: () => undefined,
      warn: () => undefined,
    },
    repository,
    reportUnexpected: (error, operation) => {
      reports.push([error, operation]);
      onReport?.(error, operation);
    },
  });
  servers.push(server);
  return { errorEvents, repository, server, reports };
}

async function createTestRoom(
  url: string,
  operationId: string,
): Promise<{ readonly roomId: string; readonly seatToken: string }> {
  const created = parseCreateRoomResponse(
    (
      await post(`${url}/rooms`, {
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        operationId,
        profile: { characterId: 'navy-bob', variant: false },
      })
    ).body,
  );
  if (!created.ok) throw new Error('create failed');
  return created.data.authority;
}

function onceEvent(client: ClientSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => client.once(event, resolve));
}

function waitForPresenceVersion(client: ClientSocket, expected: number): Promise<unknown> {
  return new Promise((resolve) => {
    const onPresence = (value: unknown) => {
      const parsed = parseCommittedRoomUpdate(value).view.presence;
      if (Number(parsed.presenceVersion) !== expected) return;
      client.off(SOCKET_EVENT.ROOM_STATE, onPresence);
      resolve(value);
    };
    client.on(SOCKET_EVENT.ROOM_STATE, onPresence);
  });
}

function emitAck(client: ClientSocket, event: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    if (payload === undefined) client.emit(event, resolve);
    else client.emit(event, payload, resolve);
  });
}

async function emitAckWithin(
  client: ClientSocket,
  event: string,
  payload?: unknown,
): Promise<unknown> {
  return within(emitAck(client, event, payload), `Socket ack: ${event}`);
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contract: createCompatibilityContract(RELEASE_ID), body }),
  });
  return { status: response.status, body: await response.json() };
}

function receiveWebSocketMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = { value: undefined as ReturnType<typeof setTimeout> | undefined };
    const cleanup = () => {
      if (timer.value !== undefined) clearTimeout(timer.value);
      client.onmessage = null;
      client.onerror = null;
      client.onclose = null;
    };
    client.onmessage = (event) => {
      cleanup();
      resolve(String(event.data));
    };
    client.onerror = () => {
      cleanup();
      reject(new Error('WebSocket opening packet error'));
    };
    client.onclose = () => {
      cleanup();
      reject(new Error('WebSocket closed before Engine.IO opening packet'));
    };
    timer.value = setTimeout(() => {
      cleanup();
      reject(new Error('Engine.IO opening packet timeout'));
    }, 2_000);
  });
}

function parseEngineIoOpenPacket(rawPacket: string): {
  readonly sid: string;
  readonly pingInterval: number;
  readonly pingTimeout: number;
} {
  const packet: unknown = JSON.parse(rawPacket);
  if (typeof packet !== 'object' || packet === null || Array.isArray(packet)) {
    throw new Error('Engine.IO opening packet must be a JSON object');
  }
  const object = packet as Record<string, unknown>;
  if (
    typeof object.sid !== 'string' ||
    typeof object.pingInterval !== 'number' ||
    typeof object.pingTimeout !== 'number'
  ) {
    throw new Error('Engine.IO opening packet has an invalid shape');
  }
  return {
    sid: object.sid,
    pingInterval: object.pingInterval,
    pingTimeout: object.pingTimeout,
  };
}
