import {
  POUR_STYLE,
  type RollCandidateEvaluation,
  type SimulationInput,
} from '@repo/dice-simulation/contract';
import { createGameClient, type RawGameSocket } from '@repo/game-client-sdk';
import { CLIENT_ERROR_CODE } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomResponse, parseJoinRoomResponse } from '@repo/game-protocol/http';
import {
  GAME_COMMAND_TYPE,
  parseCommandAck,
  parseCommittedRoomUpdate,
  parseSyncAck,
  SOCKET_EVENT,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Server as SocketIoServer } from 'socket.io';
import { type Socket as ClientSocket } from 'socket.io-client';

import {
  createSocketServerTestFixture,
  createTestRoom,
  emitAck,
  emitAckWithin,
  onceEvent,
  post,
  RELEASE_ID,
  within,
} from '@/app/socket-server.test-fixture';
import { startGameServer } from '@/app/start-game-server';
import { createAuthoritativeRollCommandExecutor } from '@/roll/authoritative-roll-command-executor';
import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';
import type { SuccessfulLogicalActionResult } from '@/rooms/application/commands/action-ledger';
import { roomId } from '@/rooms/domain/room-model';
import { RoomApplication } from '@/rooms/room-application';
import type { ErrorReporter } from '@/runtime/error-reporter';

const { servers, connect, startFaultServer, close } = createSocketServerTestFixture();

afterEach(close);

describe('Socket game dispatch', () => {
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

  test('preserves queued authoritative roll and sync admission after real SDK waiters expire', async () => {
    const simulation = Promise.withResolvers<RollCandidateEvaluation>();
    const entered = Promise.withResolvers<SimulationInput>();
    let simulationCalls = 0;
    let authorityTime = 0;
    const server = await startGameServer({
      config: {
        allowedOrigins: [],
        trustRenderProxy: false,
        host: '127.0.0.1',
        port: 0,
        releaseId: RELEASE_ID,
      },
      rolls: createAuthoritativeRollCommandExecutor({
        contract: createCompatibilityContract(RELEASE_ID),
        executionBudgetMs: 15_000,
        monotonicNow: () => authorityTime,
        logger: { error: () => {} },
        recipeSource: {
          createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
          createRollSeed: () => 'recovery-queue-seed',
          createPourStyle: () => POUR_STYLE.OBLIQUE,
        },
        simulation: {
          execute: (input, budget) => {
            simulationCalls += 1;
            expect(budget.deadlineMs).toBe(15_000);
            entered.resolve(input);
            return simulation.promise;
          },
        },
      }),
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
    // Only the network port is adapted; room FIFO, authority and Socket admission stay real.
    let connected = () => {};
    const commandAcks: ReturnType<typeof parseCommandAck>[] = [];
    const syncAcks: ReturnType<typeof parseSyncAck>[] = [];
    const raw: RawGameSocket = {
      connect: async () => connected(),
      disconnect: () => {
        creator.disconnect();
      },
      dispose: () => {
        creator.disconnect();
      },
      emitCommand: (command, acknowledge) =>
        creator.emit(SOCKET_EVENT.GAME_COMMAND, command, (value: unknown) => {
          commandAcks.push(parseCommandAck(value));
          acknowledge(value);
        }),
      emitSync: (acknowledge) =>
        creator.emit(SOCKET_EVENT.GAME_SYNC, (value: unknown) => {
          syncAcks.push(parseSyncAck(value));
          acknowledge(value);
        }),
      onConnected: (listener) => {
        connected = listener;
        return () => {};
      },
      onDisconnected: (listener) => {
        creator.on('disconnect', listener);
        return () => {
          creator.off('disconnect', listener);
        };
      },
      onRoomUpdate: (listener) => {
        creator.on(SOCKET_EVENT.ROOM_STATE, listener);
        return () => {
          creator.off(SOCKET_EVENT.ROOM_STATE, listener);
        };
      },
      onConnectionError: () => () => {},
      onReplaced: () => () => {},
    };
    const sdk = createGameClient({
      serverUrl: server.url,
      releaseId: RELEASE_ID,
      createActionId: () => 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
      retryPolicy: {
        commandResponseTimeoutMs: 80,
        retryIntervalMs: 40,
        maximumAttempts: 2,
        synchronizationTimeoutMs: 40,
      },
      socketFactory: { create: () => raw },
    }).createSession(created.data.authority);
    try {
      expect(await sdk.connect()).toEqual({ ok: true });
      const publications: unknown[] = [];
      creator.on(SOCKET_EVENT.ROOM_STATE, (value: unknown) => publications.push(value));
      const joinerUpdate = onceEvent(joiner, SOCKET_EVENT.ROOM_STATE);
      const rolled = sdk.rollDice();
      const input = await within(entered.promise, 'simulation admitted');
      expect(await within(rolled, 'SDK command and recovery waiters expire')).toMatchObject({
        ok: false,
        error: { code: CLIENT_ERROR_CODE.ACK_TIMEOUT },
      });
      expect(sdk.getSnapshot()).toMatchObject({
        syncStatus: 'idle',
        syncRevision: 1,
        error: { code: CLIENT_ERROR_CODE.ACK_TIMEOUT },
      });
      expect(commandAcks).toHaveLength(0);
      expect(syncAcks).toHaveLength(1);
      expect(await within(sdk.synchronize(), 'additional sync rejected')).toMatchObject({
        ok: false,
        error: {
          kind: 'server',
          error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: 1_000 } },
        },
      });
      expect(simulationCalls).toBe(1);
      expect(commandAcks).toHaveLength(0);
      expect(sdk.getSnapshot().syncRevision).toBe(1);

      authorityTime = 14_000;
      simulation.resolve({
        status: 'accepted',
        outcome: {
          input,
          authoritativeValuesBySlot: input.rolledSlots.map((slot) => ({ slot, value: 2 })),
        },
      });
      const committed = parseCommittedRoomUpdate(await within(joinerUpdate, 'late roll committed'));
      // A FIFO barrier also drains the original host sync/ACK after the roll commit.
      expect(parseSyncAck(await emitAckWithin(joiner, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
      expect(commandAcks).toHaveLength(2);
      expect(commandAcks[0]).toMatchObject({
        ok: true,
        data: { receipt: { stateVersion: 2, roll: {} } },
      });
      expect(commandAcks[1]).toMatchObject({
        ok: true,
        data: { receipt: commandAcks[0]!.ok ? commandAcks[0]!.data.receipt : undefined },
      });
      expect(committed.type).toBe('roll:committed');
      expect(publications).toEqual([committed]);
      expect(sdk.getSnapshot()).toMatchObject({
        error: null,
        syncRevision: 1,
        game: { stateVersion: 2 },
      });
      expect(await within(sdk.synchronize(), 'fresh confirmation')).toEqual({ ok: true });
      expect(sdk.getSnapshot().syncRevision).toBe(2);
      const duplicate = await within(sdk.rollDice(), 'completed command replay');
      expect(duplicate).toMatchObject({
        ok: true,
        data: commandAcks[0]!.ok ? commandAcks[0]!.data.receipt : undefined,
      });
      expect(simulationCalls).toBe(1);
      expect(sdk.getSnapshot()).toMatchObject({
        game: { stateVersion: 2, match: { currentTurn: { rollCount: 1 } } },
      });
      expect(parseSyncAck(await emitAckWithin(creator, SOCKET_EVENT.GAME_SYNC)).ok).toBeTrue();
      expect(publications).toEqual([committed]);
    } finally {
      simulation.reject(new Error('test ended'));
      sdk.dispose();
    }
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
});
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
