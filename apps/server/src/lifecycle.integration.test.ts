import { DICE_SIMULATION_CONTRACT, POUR_STYLE } from '@repo/dice-simulation/contract';
import { createGameClient } from '@repo/game-client-sdk';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  parseCreateRoomResponse,
  parseJoinRoomResponse,
  parseResumeRoomResponse,
  ROOM_HTTP_PATH,
} from '@repo/game-protocol/http';
import {
  GAME_COMMAND_TYPE,
  GAME_SOCKET_PATH,
  parseCommandAck,
  parseCommittedRoomUpdate,
  parseResolvedRollArtifact,
  parseSyncAck,
  SOCKET_EVENT,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { CATEGORY_IDS } from '@repo/yacht-rules';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';

import { type GameServer, startGameServer } from '@/app/start-game-server';
import type { RollCommandExecutor } from '@/roll/command-executor';
import { roomId } from '@/rooms/domain/room-model';
import { isPlayingRoomState } from '@/rooms/domain/room-state';
import { isRoomCode } from '@/rooms/domain/room-validation';
import { epochMilliseconds } from '@/rooms/domain/time';
import { InMemoryRoomRepository } from '@/rooms/repository';
import { RoomApplicationService } from '@/rooms/room-application';
import type { TaskScheduler } from '@/runtime/task-scheduler';

const RELEASE_ID = 'test-release';
const servers: GameServer[] = [];
const clients: ClientSocket[] = [];

class ManualTaskScheduler implements TaskScheduler {
  public readonly tasks: Map<
    string,
    { readonly runAt: number; readonly task: () => void | Promise<void> }
  > = new Map();

  public schedule(key: string, runAt: number, task: () => void | Promise<void>): void {
    this.tasks.set(key, { runAt, task });
  }

  public cancel(key: string): void {
    this.tasks.delete(key);
  }

  public close(): void {
    this.tasks.clear();
  }

  public async run(key: string): Promise<void> {
    const scheduled = this.tasks.get(key);
    if (scheduled === undefined) throw new Error('scheduled task missing');
    this.tasks.delete(key);
    await scheduled.task();
  }
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('deployed lifecycle adapters', () => {
  test.each(['forfeit-first', 'score-first'] as const)(
    'publishes one score result for same-time Socket commands: %s',
    async (order) => {
      let now = 3_000;
      const tasks = new ManualTaskScheduler();
      const repository = new InMemoryRoomRepository();
      const server = await startGameServer({
        config: config(),
        clock: { now: () => now },
        taskScheduler: tasks,
        repository,
        rolls: { execute: async () => ({ ok: false, reason: 'unavailable' }) },
      });
      servers.push(server);
      const { created, joined } = await bootstrapRoom(server.url);
      const creator = await connect(server.url, created.data.authority);
      const joiner = await connect(server.url, joined.data.authority);
      const id = roomId(String(created.data.authority.roomId));
      const current = repository.getById(id);
      if (current === undefined || !isPlayingRoomState(current))
        throw new Error('playing room missing');
      const completedScores = Object.fromEntries(CATEGORY_IDS.map((category) => [category, 0]));
      const finalScores = Object.fromEntries(
        CATEGORY_IDS.filter((category) => category !== 'ones').map((category) => [category, 0]),
      );
      repository.replace(id, {
        ...current,
        match: {
          ...current.match,
          players: [
            { ...current.match.players[0], scorecard: { ...completedScores, ones: 5 } },
            { ...current.match.players[1], scorecard: finalScores },
          ],
          currentTurn: {
            ...current.match.currentTurn,
            seatIndex: 1,
            diceState: {
              rollCount: 1,
              dice: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }],
            },
          },
        },
      });
      const endings = [creator, joiner].map((client) => {
        const updates: ReturnType<typeof parseCommittedRoomUpdate>[] = [];
        const finished = new Promise<void>((resolve) => {
          client.on(SOCKET_EVENT.ROOM_STATE, (raw: unknown) => {
            const update = parseCommittedRoomUpdate(raw);
            if (update.view.game?.match.status === 'finished') {
              updates.push(update);
              resolve();
            }
          });
        });
        return { updates, finished };
      });
      const firstEntered = Promise.withResolvers<void>();
      const bothEntered = Promise.withResolvers<void>();
      const captured: number[] = [];
      const { executeGameCommand } = RoomApplicationService.prototype;
      const observed = spyOn(
        RoomApplicationService.prototype,
        'executeGameCommand',
      ).mockImplementation(function (
        this: RoomApplicationService,
        input: Parameters<RoomApplicationService['executeGameCommand']>[0],
      ) {
        const result = executeGameCommand.call(this, input);
        captured.push(input.receivedAt);
        if (captured.length === 1) firstEntered.resolve();
        if (captured.length === 2) bothEntered.resolve();
        return result;
      });
      try {
        const forfeit = () =>
          emitAck(creator, SOCKET_EVENT.GAME_COMMAND, {
            type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
            actionId: crypto.randomUUID(),
          });
        const score = () =>
          emitAck(joiner, SOCKET_EVENT.GAME_COMMAND, {
            type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
            actionId: crypto.randomUUID(),
            turnId: current.match.currentTurn.id,
            categoryId: 'ones',
          });
        const first = order === 'forfeit-first' ? forfeit() : score();
        await firstEntered.promise;
        const second = order === 'forfeit-first' ? score() : forfeit();
        await bothEntered.promise;
        expect(captured).toEqual([3_000, 3_000]);
        now = 3_001;
        for (const [key, task] of [...tasks.tasks]) if (task.runAt <= now) await tasks.run(key);
        const [firstAck, secondAck] = await Promise.all([first, second]);
        const scored = parseCommandAck(order === 'forfeit-first' ? secondAck : firstAck);
        const forfeited = parseCommandAck(order === 'forfeit-first' ? firstAck : secondAck);
        expect(scored).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
        expect(forfeited).toMatchObject({
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.MATCH_FINISHED },
        });
        await Promise.all(endings.map((ending) => ending.finished));
        const synced = await Promise.all(
          [creator, joiner].map(async (client) =>
            parseSyncAck(await emitAck(client, SOCKET_EVENT.GAME_SYNC)),
          ),
        );
        for (const snapshot of synced)
          expect(snapshot).toMatchObject({
            ok: true,
            data: {
              game: {
                stateVersion: 2,
                match: {
                  status: 'finished',
                  result: { reason: 'scoresCompleted', winnerSeatIndex: 0 },
                },
              },
            },
          });
        expect(endings.map((ending) => ending.updates.length)).toEqual([1, 1]);
      } finally {
        observed.mockRestore();
      }
    },
  );

  test('keeps Socket score and forfeit available after the opponent exhausts its ledger', async () => {
    const repository = new InMemoryRoomRepository();
    const server = await startGameServer({
      config: config(),
      repository,
      rolls: { execute: async () => ({ ok: false, reason: 'unavailable' }) },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    servers.push(server);
    const { created, joined } = await bootstrapRoom(server.url);
    const creator = await connect(server.url, created.data.authority);
    const joiner = await connect(server.url, joined.data.authority);
    const id = roomId(String(created.data.authority.roomId));
    const current = repository.getById(id);
    if (current === undefined || !isPlayingRoomState(current))
      throw new Error('playing room missing');
    repository.replace(id, {
      ...current,
      match: {
        ...current.match,
        currentTurn: {
          ...current.match.currentTurn,
          diceState: {
            rollCount: 1,
            dice: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }],
          },
        },
      },
    });
    for (let index = 0; index < 2_048; index += 1) {
      const rejected = parseCommandAck(
        await emitAck(joiner, SOCKET_EVENT.GAME_COMMAND, {
          type: GAME_COMMAND_TYPE.ROLL_DICE,
          actionId: crypto.randomUUID(),
          turnId: current.match.currentTurn.id,
        }),
      );
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          code: index < 1_024 ? PUBLIC_ERROR_CODE.NOT_YOUR_TURN : PUBLIC_ERROR_CODE.RATE_LIMITED,
        },
      });
    }
    const score = parseCommandAck(
      await emitAck(creator, SOCKET_EVENT.GAME_COMMAND, {
        type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
        actionId: crypto.randomUUID(),
        turnId: current.match.currentTurn.id,
        categoryId: 'ones',
      }),
    );
    expect(score).toMatchObject({ ok: true, data: { receipt: { stateVersion: 2 } } });
    const forfeit = parseCommandAck(
      await emitAck(creator, SOCKET_EVENT.GAME_COMMAND, {
        type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
        actionId: crypto.randomUUID(),
      }),
    );
    expect(forfeit).toMatchObject({ ok: true, data: { receipt: { stateVersion: 3 } } });
    expect(repository.getById(id)?.match).toMatchObject({
      status: 'finished',
      result: { reason: 'explicitForfeit', winnerSeatIndex: 1 },
    });
    expect(repository.getById(id)?.actionLedger).toHaveLength(1_026);
  }, 10_000);

  test('bounds HTTP recovery behind a running roll while admitting the internal deadline', async () => {
    let now = 1_000;
    const tasks = new ManualTaskScheduler();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = await startGameServer({
      config: config(),
      clock: { now: () => now },
      taskScheduler: tasks,
      rolls: {
        execute: async () => {
          entered.resolve();
          await release.promise;
          return { ok: false, reason: 'unavailable' };
        },
      },
    });
    servers.push(server);
    const { created } = await bootstrapRoom(server.url);
    const creator = await connect(server.url, created.data.authority);
    const initial = parseSyncAck(await emitAck(creator, SOCKET_EVENT.GAME_SYNC));
    if (!initial.ok || initial.data.game === null || initial.data.game.match.status !== 'playing')
      throw new Error('initial sync failed');
    const roll = emitAck(creator, SOCKET_EVENT.GAME_COMMAND, {
      type: GAME_COMMAND_TYPE.ROLL_DICE,
      actionId: crypto.randomUUID(),
      turnId: initial.data.game.match.currentTurn.turnId,
    });
    await entered.promise;
    let rejections = 0;
    const requests = Array.from({ length: 100 }, () =>
      post(`${server.url}${ROOM_HTTP_PATH.resume(created.data.authority.roomId)}`, {
        seatToken: created.data.authority.seatToken,
      }).then((response) => {
        if (response.status === 429) rejections += 1;
        return response;
      }),
    );
    try {
      const waitUntil = performance.now() + 2_000;
      while (performance.now() < waitUntil) {
        if (rejections >= 69) break;
        await Bun.sleep(1);
      }
      expect(rejections).toBe(69);
      expect(server.telemetry.snapshot().retention).toMatchObject({
        roomRequests: 32,
        httpRequests: 31,
        queueRooms: 1,
      });
      expect(parseSyncAck(await emitAck(creator, SOCKET_EVENT.GAME_SYNC))).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED },
      });
      const deadline = tasks.tasks.get(created.data.authority.roomId);
      if (deadline === undefined) throw new Error('deadline missing');
      now = deadline.runAt;
      const expiration = tasks.run(created.data.authority.roomId);
      release.resolve();
      expect(parseCommandAck(await roll)).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE },
      });
      const responses = (await Promise.all(requests)).map((response) =>
        parseResumeRoomResponse(response.body),
      );
      expect(responses.filter((response) => response.ok)).toHaveLength(31);
      expect(
        responses.filter(
          (response) => !response.ok && response.error.code === PUBLIC_ERROR_CODE.RATE_LIMITED,
        ),
      ).toHaveLength(69);
      await expiration;
      expect(parseSyncAck(await emitAck(creator, SOCKET_EVENT.GAME_SYNC))).toMatchObject({
        ok: true,
        data: { game: { stateVersion: 2 } },
      });
      expect(server.telemetry.snapshot().retention).toMatchObject({
        roomRequests: 0,
        httpRequests: 0,
        queueRooms: 0,
      });
      expect(server.telemetry.snapshot().actions.pending).toBe(0);
    } finally {
      release.resolve();
      await Promise.all([roll, ...requests]);
    }
  });

  test('broadcasts the initial game to a creator connected while the room is waiting', async () => {
    const server = await startGameServer({ config: config() });
    servers.push(server);
    const created = parseCreateRoomResponse(
      (
        await post(`${server.url}/rooms`, {
          clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
          operationId: 'fd8341e6-899d-4f95-9a72-dc128e7f32a0',
          profile: { characterId: 'navy-bob', variant: false },
        })
      ).body,
    );
    if (!created.ok) throw new Error('create failed');
    const creator = await connect(server.url, created.data.authority);
    const gameEvent = onceEvent(creator, SOCKET_EVENT.ROOM_STATE);

    const joined = parseJoinRoomResponse(
      (
        await post(`${server.url}/rooms/${created.data.view.room.roomCode}/join`, {
          clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398440',
          operationId: 'e4887f7c-996d-4a3a-83ae-8a7e262e9388',
          profile: { characterId: 'blonde-buns', variant: false },
        })
      ).body,
    );

    expect(joined.ok).toBeTrue();
    const update = parseCommittedRoomUpdate(await gameEvent);
    expect(update.view.game?.match.status).toBe('playing');
    expect(update.view.room.status).toBe('playing');
    expect(update.view.presence.seats).toHaveLength(2);
  });

  test('publishes one deadline transition and restores a client that missed the event', async () => {
    let now: number = 1_000;
    const tasks = new ManualTaskScheduler();
    const server = await startGameServer({
      clock: { now: () => now },
      config: config(),
      taskScheduler: tasks,
    });
    servers.push(server);

    const { created, joined } = await bootstrapRoom(server.url);
    const creator = await connect(server.url, created.data.authority);
    const initial = parseSyncAck(await emitAck(creator, SOCKET_EVENT.GAME_SYNC));
    if (!initial.ok || initial.data.game === null) throw new Error('initial sync failed');
    expect(Number(initial.data.game.stateVersion)).toBe(1);

    const scheduled = tasks.tasks.get(created.data.authority.roomId);
    if (scheduled === undefined) throw new Error('turn deadline was not scheduled');
    now = scheduled.runAt;
    const committedEvent = onceEvent(creator, SOCKET_EVENT.ROOM_STATE);

    await tasks.run(created.data.authority.roomId);

    const committed = parseCommittedRoomUpdate(await committedEvent);
    expect(Number(committed.view.game?.stateVersion)).toBe(2);
    expect(committed.view.game?.match).toMatchObject({
      status: 'playing',
      players: [{ timeoutCount: 1 }, { timeoutCount: 0 }],
    });

    const recoveredJoiner = await connect(server.url, joined.data.authority);
    const recovered = parseSyncAck(await emitAck(recoveredJoiner, SOCKET_EVENT.GAME_SYNC));
    expect(recovered).toMatchObject({
      ok: true,
      data: { game: { stateVersion: 2, match: { status: 'playing' } } },
    });
  });

  test('periodic maintenance removes expired indexes and stops with the server', async () => {
    let now: number = 1_000;
    const repository = new InMemoryRoomRepository();
    const tasks = new ManualTaskScheduler();
    const server = await startGameServer({
      clock: { now: () => now },
      config: config(),
      repository,
      taskScheduler: tasks,
    });
    servers.push(server);
    const created = parseCreateRoomResponse(
      (
        await post(`${server.url}/rooms`, {
          clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
          operationId: '60aad78f-8e88-4705-999d-2ff80c392d9d',
          profile: { characterId: 'navy-bob', variant: false },
        })
      ).body,
    );
    if (!created.ok) throw new Error('create failed');
    expect(tasks.tasks.get('maintenance:rooms')?.runAt).toBe(31_000);
    now = 31_000;
    await tasks.run('maintenance:rooms');
    expect(repository.counts().rooms).toBe(1);
    expect(tasks.tasks.get('maintenance:rooms')?.runAt).toBe(61_000);
    now = 61_000;
    const candidates = spyOn(repository, 'listMaintenanceCandidateRoomIds').mockImplementationOnce(
      () => {
        throw new Error('cleanup unavailable');
      },
    );
    try {
      await expect(tasks.run('maintenance:rooms')).rejects.toThrow('cleanup unavailable');
      expect(tasks.tasks.get('maintenance:rooms')?.runAt).toBe(91_000);
    } finally {
      candidates.mockRestore();
    }
    now = 301_000;
    await tasks.run('maintenance:rooms');
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
    const removedCode: unknown = String(created.data.view.room.roomCode);
    if (!isRoomCode(removedCode)) throw new Error('fixture produced an invalid room code');
    expect(repository.findRoomIdByCode(removedCode)).toBeUndefined();
    const pending = Promise.withResolvers<void>();
    const cleanup = spyOn(RoomApplicationService.prototype, 'cleanupRooms').mockReturnValueOnce(
      pending.promise,
    );
    try {
      const running = tasks.run('maintenance:rooms');
      expect(tasks.tasks.has('maintenance:rooms')).toBeFalse();
      await server.close();
      pending.resolve();
      await running;
      expect(tasks.tasks.size).toBe(0);
    } finally {
      pending.resolve();
      cleanup.mockRestore();
    }
  });

  test.each(['expiry', 'cancel'] as const)(
    '%s releases an actual waiting Socket and allows another room connection',
    async (removal) => {
      let now = 1_000;
      const repository = new InMemoryRoomRepository();
      const tasks = new ManualTaskScheduler();
      const server = await startGameServer({
        clock: { now: () => now },
        config: config(),
        repository,
        taskScheduler: tasks,
      });
      servers.push(server);
      const created = parseCreateRoomResponse(
        (
          await post(`${server.url}${ROOM_HTTP_PATH.CREATE}`, {
            clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
            operationId: crypto.randomUUID(),
            profile: { characterId: 'navy-bob', variant: false },
          })
        ).body,
      );
      if (!created.ok) throw new Error('create failed');
      const creator = await connect(server.url, created.data.authority);
      const disconnected = onceEvent(creator, 'disconnect');

      if (removal === 'expiry') {
        now = 301_000;
        await tasks.run('maintenance:rooms');
      } else {
        const cancelled = await post(
          `${server.url}${ROOM_HTTP_PATH.cancel(created.data.authority.roomId)}`,
          { seatToken: created.data.authority.seatToken },
        );
        expect(cancelled.status).toBe(200);
      }

      await Promise.race([disconnected, Bun.sleep(500)]);
      expect(creator.connected).toBeFalse();
      expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
      const next = parseCreateRoomResponse(
        (
          await post(`${server.url}${ROOM_HTTP_PATH.CREATE}`, {
            clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
            operationId: crypto.randomUUID(),
            profile: { characterId: 'navy-bob', variant: false },
          })
        ).body,
      );
      if (!next.ok) throw new Error('next create failed');
      expect((await connect(server.url, next.data.authority)).connected).toBeTrue();
    },
  );

  test('sends the finished snapshot before closing remaining Result connections', async () => {
    let now = 3_000;
    const repository = new InMemoryRoomRepository();
    const tasks = new ManualTaskScheduler();
    const server = await startGameServer({
      config: config(),
      repository,
      taskScheduler: tasks,
      clock: { now: () => now },
    });
    servers.push(server);
    const { created, joined } = await bootstrapRoom(server.url);
    const creator = await connect(server.url, created.data.authority);
    const guest = await connect(server.url, joined.data.authority);
    const entered = Promise.withResolvers<void>();
    const { executeGameCommand } = RoomApplicationService.prototype;
    const observed = spyOn(
      RoomApplicationService.prototype,
      'executeGameCommand',
    ).mockImplementationOnce(function (
      this: RoomApplicationService,
      input: Parameters<RoomApplicationService['executeGameCommand']>[0],
    ) {
      const result = executeGameCommand.call(this, input);
      entered.resolve();
      return result;
    });
    try {
      const ack = emitAck(creator, SOCKET_EVENT.GAME_COMMAND, {
        type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
        actionId: crypto.randomUUID(),
      });
      await entered.promise;
      now = 3_001;
      for (const [key, task] of [...tasks.tasks]) if (task.runAt <= now) await tasks.run(key);
      expect(await ack).toMatchObject({ ok: true });
    } finally {
      observed.mockRestore();
    }
    await Promise.all([
      emitAck(creator, SOCKET_EVENT.GAME_SYNC),
      emitAck(guest, SOCKET_EVENT.GAME_SYNC),
    ]);
    const finalCreator = onceEvent(creator, SOCKET_EVENT.ROOM_STATE);
    const finalGuest = onceEvent(guest, SOCKET_EVENT.ROOM_STATE);
    const creatorClosed = onceEvent(creator, 'disconnect');
    const guestClosed = onceEvent(guest, 'disconnect');

    await tasks.run('maintenance:rooms');

    expect(parseCommittedRoomUpdate(await finalCreator).view.game?.match.status).toBe('finished');
    expect(parseCommittedRoomUpdate(await finalGuest).view.game?.match.status).toBe('finished');
    await Promise.all([creatorClosed, guestClosed]);
    expect(creator.connected).toBeFalse();
    expect(guest.connected).toBeFalse();
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
  });

  test('SDK retains an expired-turn forfeit result when cleanup immediately closes the room', async () => {
    let now = 3_000;
    const repository = new InMemoryRoomRepository();
    const tasks = new ManualTaskScheduler();
    const sent = Promise.withResolvers<void>();
    const server = await startGameServer({
      config: config(),
      repository,
      taskScheduler: tasks,
      clock: { now: () => now },
      rolls: { execute: async () => ({ ok: false, reason: 'unavailable' }) },
      logger: {
        debug: (event) => {
          if (event === 'socket.command.completed') sent.resolve();
        },
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    servers.push(server);
    const { created } = await bootstrapRoom(server.url);
    const session = createGameClient({
      serverUrl: server.url,
      releaseId: RELEASE_ID,
      retryPolicy: { acknowledgementTimeoutMs: 1_000, maximumAttempts: 1, retryDelayMs: 0 },
    }).createSession(created.data.authority);
    const disconnected = Promise.withResolvers<void>();
    session.subscribe(() => {
      if (session.getSnapshot().connection === 'disconnected') disconnected.resolve();
    });
    const entered = Promise.withResolvers<void>();
    const { executeGameCommand } = RoomApplicationService.prototype;
    const observed = spyOn(
      RoomApplicationService.prototype,
      'executeGameCommand',
    ).mockImplementationOnce(function (
      this: RoomApplicationService,
      input: Parameters<RoomApplicationService['executeGameCommand']>[0],
    ) {
      const result = executeGameCommand.call(this, input);
      entered.resolve();
      return result;
    });
    try {
      expect(await session.connect()).toEqual({ ok: true });
      const initial = session.getSnapshot().game;
      if (initial === null || initial.match.status !== 'playing')
        throw new Error('playing snapshot missing');
      now = initial.match.currentTurn.deadlineAt + 1;
      const forfeiting = session.forfeitMatch();
      await entered.promise;
      now += 1;
      await tasks.run(`command-quantum:${created.data.authority.roomId}`);
      await sent.promise;
      await tasks.run('maintenance:rooms');
      await disconnected.promise;

      expect(session.getSnapshot().game).toMatchObject({
        stateVersion: initial.stateVersion + 1,
        match: {
          status: 'finished',
          result: { reason: 'explicitForfeit', winnerSeatIndex: 1 },
        },
      });
      expect(await forfeiting).toMatchObject({
        ok: true,
        data: { stateVersion: initial.stateVersion + 1 },
      });
      expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
    } finally {
      session.dispose();
      observed.mockRestore();
    }
  });

  test.each([
    { cleanup: false, expiredLedger: true },
    { cleanup: true, expiredLedger: false },
    { cleanup: true, expiredLedger: true },
  ])(
    'publishes a running roll before the final timeout: %j',
    async ({ cleanup, expiredLedger }) => {
      let now = 3_000;
      const repository = new InMemoryRoomRepository();
      const tasks = new ManualTaskScheduler();
      const entered = Promise.withResolvers<void>();
      const physical = Promise.withResolvers<Awaited<ReturnType<RollCommandExecutor['execute']>>>();
      const server = await startGameServer({
        config: config(),
        repository,
        taskScheduler: tasks,
        clock: { now: () => now },
        rolls: {
          execute: () => {
            entered.resolve();
            return physical.promise;
          },
        },
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      });
      servers.push(server);
      const { created, joined } = await bootstrapRoom(server.url);
      const id = roomId(String(created.data.authority.roomId));
      const current = repository.getById(id);
      if (current === undefined || !isPlayingRoomState(current))
        throw new Error('playing room missing');
      repository.replace(id, {
        ...current,
        stateVersion: 6,
        match: {
          ...current.match,
          players: [
            { scorecard: { ones: 1, twos: 0 }, timeoutCount: 2 },
            { scorecard: { ones: 0, twos: 0 }, timeoutCount: 2 },
          ],
          currentTurn: {
            ...current.match.currentTurn,
            startedAt: epochMilliseconds(243_004),
            deadlineAt: epochMilliseconds(303_004),
          },
        },
        actionLedger: expiredLedger
          ? [
              {
                status: 'completed',
                actionId: crypto.randomUUID(),
                seatIndex: 0,
                fingerprint: 'prior-roll',
                expiresAt: 303_000,
                result: {
                  ok: true,
                  stateVersion: 2,
                  roll: resolvedRollArtifact(crypto.randomUUID()),
                },
              },
            ]
          : [],
      });
      now = 273_500;
      await tasks.run('maintenance:rooms');
      const observer = await connect(server.url, joined.data.authority);
      const observerClosed = onceEvent(observer, 'disconnect');
      const versions: number[] = [];
      const observedFinished = Promise.withResolvers<void>();
      observer.on(SOCKET_EVENT.ROOM_STATE, (raw: unknown) => {
        const update = parseCommittedRoomUpdate(raw);
        if (update.view.game === null) throw new Error('expected active match update');
        // Presence now carries the full game too; count only game advances after the v6 baseline.
        if (update.view.game.stateVersion > 6) versions.push(update.view.game.stateVersion);
        if (update.view.game?.match.status === 'finished') observedFinished.resolve();
      });
      const session = createGameClient({
        serverUrl: server.url,
        releaseId: RELEASE_ID,
        retryPolicy: { acknowledgementTimeoutMs: 1_000, maximumAttempts: 1, retryDelayMs: 0 },
      }).createSession(created.data.authority);
      const disconnected = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      session.subscribe(() => {
        const snapshot = session.getSnapshot();
        if (snapshot.connection === 'disconnected') disconnected.resolve();
        if (snapshot.game?.match.status === 'finished') finished.resolve();
      });
      let rolling: ReturnType<typeof session.rollDice> | undefined;
      try {
        expect(await session.connect()).toEqual({ ok: true });
        expect(Number(session.getSnapshot().game?.stateVersion)).toBe(6);
        now = 302_999;
        rolling = session.rollDice();
        await entered.promise;
        now = 303_500;
        const expiring = tasks.run(String(id));
        const cleaning = cleanup ? tasks.run('maintenance:rooms') : Promise.resolve();
        physical.resolve({ ok: true, artifact: resolvedRollArtifact(crypto.randomUUID()) });
        await Promise.all([expiring, cleaning]);
        if (cleanup && expiredLedger) await Promise.all([disconnected.promise, observerClosed]);
        else await Promise.all([finished.promise, rolling]);
        await observedFinished.promise;

        expect(session.getSnapshot().game).toMatchObject({
          stateVersion: 8,
          match: {
            status: 'finished',
            result: { reason: 'timeoutLimit', winnerSeatIndex: 1 },
          },
        });
        expect(versions).toEqual(cleanup && expiredLedger ? [7, 8, 8] : [7, 8]);
        expect(repository.counts().rooms).toBe(cleanup && expiredLedger ? 0 : 1);
      } finally {
        physical.resolve({ ok: false, reason: 'unavailable' });
        session.dispose();
        await rolling;
      }
    },
  );

  test('room cancellation closes a transport still waiting for namespace authentication', async () => {
    const server = await startGameServer({ config: config() });
    servers.push(server);
    const created = parseCreateRoomResponse(
      (
        await post(`${server.url}${ROOM_HTTP_PATH.CREATE}`, {
          clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
          operationId: crypto.randomUUID(),
          profile: { characterId: 'navy-bob', variant: false },
        })
      ).body,
    );
    if (!created.ok) throw new Error('create failed');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { connectSeat } = RoomApplicationService.prototype;
    const pending = spyOn(RoomApplicationService.prototype, 'connectSeat').mockImplementationOnce(
      async function (
        this: RoomApplicationService,
        input: Parameters<RoomApplicationService['connectSeat']>[0],
      ) {
        entered.resolve();
        await release.promise;
        return connectSeat.call(this, input);
      },
    );
    try {
      const client = createClient(server.url, {
        path: GAME_SOCKET_PATH,
        transports: ['websocket'],
        reconnection: false,
        auth: {
          executionId: crypto.randomUUID(),
          connectionIntent: 'enter',
          roomId: created.data.authority.roomId,
          seatToken: created.data.authority.seatToken,
          contract: createCompatibilityContract(RELEASE_ID),
        },
      });
      clients.push(client);
      await entered.promise;
      const transportClosed = new Promise<void>((resolve) =>
        client.io.engine.once('close', () => resolve()),
      );
      await post(`${server.url}${ROOM_HTTP_PATH.cancel(created.data.authority.roomId)}`, {
        seatToken: created.data.authority.seatToken,
      });
      await Promise.race([transportClosed, Bun.sleep(500)]);
      expect(client.io.engine.readyState).toBe('closed');
      release.resolve();
    } finally {
      release.resolve();
      pending.mockRestore();
    }
  });

  test.each([91_999, 92_000, 92_001])(
    'HTTP and actual Socket admission agree on a disconnected peer deadline at %d',
    async (checkedAt) => {
      let now = 1_000;
      const repository = new InMemoryRoomRepository();
      const server = await startGameServer({
        clock: { now: () => now },
        config: config(),
        repository,
        // Intentionally hold the timer: admission cannot depend on its punctuality.
        taskScheduler: new ManualTaskScheduler(),
      });
      servers.push(server);
      const { created, joined } = await bootstrapRoom(server.url);
      const creator = await connect(server.url, created.data.authority);
      const joiner = await connect(server.url, joined.data.authority);
      const creatorLeft = onceEvent(joiner, SOCKET_EVENT.ROOM_STATE);
      now = 2_000;
      creator.disconnect();
      await creatorLeft;
      now = 62_000;
      joiner.disconnect();
      const disconnectedBy = performance.now() + 1_000;
      while (server.telemetry.snapshot().presence.connections !== 0) {
        if (performance.now() >= disconnectedBy) throw new Error('disconnect was not observed');
        await Bun.sleep(1);
      }
      const id = roomId(String(created.data.authority.roomId));
      const before = repository.getById(id);
      expect(before?.room.seats[1]?.presence).toMatchObject({ reconnectDeadlineAt: 152_000 });
      now = checkedAt;

      const http = parseResumeRoomResponse(
        (
          await post(`${server.url}${ROOM_HTTP_PATH.resume(joined.data.authority.roomId)}`, {
            seatToken: joined.data.authority.seatToken,
          })
        ).body,
      );
      expect(http.ok).toBe(checkedAt < 92_000);
      expect(repository.getById(id)).toBe(before);
      if (checkedAt < 92_000) {
        const restored = await connect(server.url, joined.data.authority);
        expect(restored.connected).toBeTrue();
      } else {
        await expect(connect(server.url, joined.data.authority)).rejects.toMatchObject({
          data: { error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE } },
        });
        expect(repository.getById(id)).toBe(before);
      }
    },
  );
});

function resolvedRollArtifact(rollId: string) {
  return parseResolvedRollArtifact({
    type: 'roll:resolved',
    replay: {
      mode: 'seeded-physics',
      rollId,
      seed: 'ab'.repeat(16),
      pourStyle: POUR_STYLE.CLASSIC,
      rolledSlots: [0, 1, 2, 3, 4],
      contract: createCompatibilityContract(RELEASE_ID),
    },
    outcome: {
      authoritativeValuesBySlot: [0, 1, 2, 3, 4].map((slot) => ({ slot, value: slot + 1 })),
    },
    replayDigest: `${DICE_SIMULATION_CONTRACT.replayDigestVersion}:${'a'.repeat(64)}`,
  });
}

function config() {
  return {
    allowedOrigins: [],
    trustRenderProxy: false,
    host: '127.0.0.1',
    port: 0,
    releaseId: RELEASE_ID,
  };
}

async function bootstrapRoom(url: string) {
  const created = parseCreateRoomResponse(
    (
      await post(`${url}/rooms`, {
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        operationId: 'fd8341e6-899d-4f95-9a72-dc128e7f32a0',
        profile: { characterId: 'navy-bob', variant: false },
      })
    ).body,
  );
  if (!created.ok) throw new Error('create failed');
  const joined = parseJoinRoomResponse(
    (
      await post(`${url}/rooms/${created.data.view.room.roomCode}/join`, {
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398440',
        operationId: 'e4887f7c-996d-4a3a-83ae-8a7e262e9388',
        profile: { characterId: 'blonde-buns', variant: false },
      })
    ).body,
  );
  if (!joined.ok) throw new Error('join failed');
  return { created, joined };
}

async function connect(url: string, authority: { roomId: string; seatToken: string }) {
  const client = createClient(url, {
    autoConnect: false,
    path: GAME_SOCKET_PATH,
    transports: ['websocket'],
    auth: {
      executionId: crypto.randomUUID(),
      connectionIntent: 'enter',
      roomId: authority.roomId,
      seatToken: authority.seatToken,
      contract: createCompatibilityContract(RELEASE_ID),
    },
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
    client.connect();
  });
  return client;
}

function onceEvent(client: ClientSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => client.once(event, resolve));
}

function emitAck(client: ClientSocket, event: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    if (payload === undefined) client.emit(event, resolve);
    else client.emit(event, payload, resolve);
  });
}

async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contract: createCompatibilityContract(RELEASE_ID), body }),
  });
  return { status: response.status, body: await response.json() };
}
