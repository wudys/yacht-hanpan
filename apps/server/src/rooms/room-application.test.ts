import { DICE_SIMULATION_CONTRACT, POUR_STYLE } from '@repo/dice-simulation/contract';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  parseCancelRoomRequest,
  parseCreateRoomRequest,
  parseJoinRoomRequest,
  parseResumeRoomRequest,
} from '@repo/game-protocol/http';
import {
  GAME_COMMAND_TYPE,
  parseGameCommand,
  parseResolvedRollArtifact,
  parseSocketAuth,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { expect, spyOn, test } from 'bun:test';

import type { RollCommandExecution, RollCommandExecutor } from '@/roll/command-executor';
import { CreateRoomRateLimiter } from '@/rooms/admission/create-room-rate-limit';
import type { ExecuteGameCommandResult } from '@/rooms/commands/execute-game-command';
import { PendingActionRegistry } from '@/rooms/commands/pending-action-registry';
import { RoomStateCommitter, type RoomStatePublication } from '@/rooms/commit';
import { ConnectionRegistry } from '@/rooms/connections/connection-registry';
import { roomId } from '@/rooms/domain/room-model';
import { isPlayingRoomState } from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';
import { InMemoryRoomRepository } from '@/rooms/repository';
import { RoomApplicationService } from '@/rooms/room-application';
import { InMemoryRoomTaskQueue } from '@/rooms/scheduling/room-task-queue';

const ROOM_ID = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39843e');
const TOKEN = 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91';
const JOINER_TOKEN = '9207e571-a39a-49d5-a75f-a08d5e52cce8';
const contract = createCompatibilityContract('test-release');

async function fixture(
  queue: InMemoryRoomTaskQueue = new InMemoryRoomTaskQueue(),
  rolls: RollCommandExecutor = {
    execute: () => {
      throw new Error('unexpected roll');
    },
  },
) {
  let now = 1_000;
  const repository = new InMemoryRoomRepository();
  const connections = new ConnectionRegistry();
  const pending = new PendingActionRegistry<ExecuteGameCommandResult>();
  const started: unknown[] = [];
  const scheduled = new Map<string, { runAt: number; task: () => void | Promise<void> }>();
  const published: { publication: RoomStatePublication; runAt: number | null }[] = [];
  const rateLimiter = new CreateRoomRateLimiter();
  let issuedTokens = 0;
  const service = new RoomApplicationService({
    clock: { now: () => now },
    connections,
    expectedContract: contract,
    identity: {
      createRoomCodeCandidate: () => '001204',
      createRoomId: () => ROOM_ID,
      createSeatToken: () => (issuedTokens++ === 0 ? TOKEN : JOINER_TOKEN),
      createTurnId: () => '018f47f2-c2d8-7f4a-8bf4-3f559c398441',
    },
    publishRoomState: (publication) => {
      if (publication.kind === 'started') started.push(publication.view);
      published.push({ publication, runAt: scheduled.get(publication.roomId)?.runAt ?? null });
    },
    pending,
    queue,
    rateLimiter,
    repository,
    readStats: () => ({
      rooms: repository.telemetryCounts(),
      pending: pending.totalCount(),
      presence: connections.counts(),
      retention: {
        roomRequests: queue.pendingRequestCount,
        queueRooms: queue.activeRoomCount,
        createAddresses: rateLimiter.trackedAddressCount,
      },
    }),
    rolls,
    tasks: {
      schedule: (key, runAt, task) => {
        scheduled.set(key, { runAt, task });
      },
      cancel: (key) => {
        scheduled.delete(key);
      },
      close: () => scheduled.clear(),
    },
  });
  const createRequest = parseCreateRoomRequest({
    clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
    operationId: '4ba1e7d4-c077-4b80-b198-9b1f04c182c8',
    profile: { characterId: 'navy-bob', variant: false },
  });
  const created = await service.createRoom(createRequest, '192.0.2.1');
  if (!created.ok) throw new Error('fixture create failed');
  return {
    created,
    createRequest,
    issuedTokenCount: () => issuedTokens,
    service,
    queue,
    rateLimiter,
    repository,
    connections,
    pending,
    started,
    scheduled,
    published,
    runDeadline: async () => {
      const wake = scheduled.get(ROOM_ID);
      if (wake === undefined) throw new Error('deadline task missing');
      scheduled.delete(ROOM_ID);
      await wake.task();
    },
    setNow: (value: number) => {
      now = value;
    },
    commits: new RoomStateCommitter({
      repository: repository,
      clock: { now: () => 0 },
      publishRoomState: () => undefined,
    }),
  };
}

async function startGame(state: Awaited<ReturnType<typeof fixture>>) {
  state.setNow(2_000);
  const joined = await state.service.joinRoom(
    parseJoinRoomRequest({
      clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398445',
      operationId: crypto.randomUUID(),
      roomCode: '001204',
      profile: { characterId: 'blonde-buns', variant: false },
    }),
  );
  if (!joined.ok) throw new Error('join failed');
  return joined.data;
}

function playingRecord(state: Awaited<ReturnType<typeof fixture>>) {
  const record = state.repository.getById(ROOM_ID);
  if (record === undefined || !isPlayingRoomState(record)) throw new Error('playing room missing');
  return record;
}

function rollArtifact() {
  return parseResolvedRollArtifact({
    type: 'roll:resolved',
    replay: {
      mode: 'seeded-physics',
      rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
      seed: 'ab'.repeat(32),
      pourStyle: POUR_STYLE.CLASSIC,
      rolledSlots: [0, 1, 2, 3, 4],
      contract,
    },
    outcome: {
      authoritativeValuesBySlot: [
        { slot: 0, value: 1 },
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    },
    replayDigest: `${DICE_SIMULATION_CONTRACT.replayDigestVersion}:${'a'.repeat(64)}`,
  });
}

test('replays create authority until the exact 60-second application retention boundary', async () => {
  const state = await fixture();
  try {
    expect(state.issuedTokenCount()).toBe(1);
    expect(
      (
        await state.service.cancelRoom(
          parseCancelRoomRequest({
            roomId: ROOM_ID,
            seatToken: TOKEN,
          }),
        )
      ).ok,
    ).toBeTrue();
    expect(state.repository.counts().rooms).toBe(0);

    state.setNow(60_999);
    expect(await state.service.createRoom(state.createRequest, '192.0.2.1')).toEqual(state.created);
    expect(state.issuedTokenCount()).toBe(1);
    expect(state.repository.counts().rooms).toBe(0);

    state.setNow(61_000);
    const fresh = await state.service.createRoom(state.createRequest, '192.0.2.1');
    expect(fresh.ok).toBeTrue();
    if (!fresh.ok) throw new Error('expired operation did not create a room');
    expect(fresh.data.authority.seatToken).toBe(JOINER_TOKEN);
    expect(fresh.data.authority.seatToken).not.toBe(state.created.data.authority.seatToken);
    expect(state.issuedTokenCount()).toBe(2);
    expect(state.repository.counts().rooms).toBe(1);
    expect(state.repository.getById(ROOM_ID)?.room.createdAt).toBe(epochMilliseconds(61_000));
  } finally {
    state.service.close();
  }
});

test('maintenance reclaims idle IP attempts without another create request', async () => {
  const state = await fixture();
  expect(state.rateLimiter.trackedAddressCount).toBe(1);
  state.setNow(61_000);
  await state.service.cleanupRooms();
  expect(state.rateLimiter.trackedAddressCount).toBe(0);
  expect(state.repository.counts().rooms).toBe(1);
  state.service.close();
});

test('close releases a captured forfeit without a commit or pending action', async () => {
  const wakes = new Set<string>();
  const queue = new InMemoryRoomTaskQueue({
    clock: { now: () => 3_000 },
    tasks: {
      schedule: (key) => {
        wakes.add(key);
      },
      cancel: (key) => {
        wakes.delete(key);
      },
    },
  });
  const state = await fixture(queue);
  state.setNow(2_000);
  const joined = await state.service.joinRoom(
    parseJoinRoomRequest({
      clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398445',
      operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
      roomCode: '001204',
      profile: { characterId: 'blonde-buns', variant: false },
    }),
  );
  if (!joined.ok) throw new Error('join failed');
  state.setNow(3_000);
  const before = state.repository.getById(ROOM_ID);
  const command = state.service.executeGameCommand({
    roomId: ROOM_ID,
    seatIndex: 0,
    receivedAt: 3_000,
    command: parseGameCommand({
      type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
      actionId: crypto.randomUUID(),
    }),
  });
  expect(state.pending.totalCount()).toBe(1);
  expect(wakes.size).toBe(1);
  state.service.close();
  expect((await command).result).toMatchObject({
    ok: false,
    error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED },
  });
  expect(state.repository.getById(ROOM_ID)).toBe(before);
  expect(state.pending.totalCount()).toBe(0);
  expect(queue.pendingRequestCount).toBe(0);
  expect(queue.activeRoomCount).toBe(0);
  expect(wakes.size).toBe(0);
  expect(state.scheduled.size).toBe(0);
});

test.each(['join', 'cancel', 'resume', 'connect', 'sync', 'command'] as const)(
  '%s rejects queue saturation before execution',
  async (operation) => {
    const state = await fixture(new InMemoryRoomTaskQueue({ maxRequestsPerRoom: 1 }));
    const gate = Promise.withResolvers<void>();
    const blocker = state.queue.runRequest(ROOM_ID, () => gate.promise);
    const previous = state.repository.getById(ROOM_ID);
    const requests = {
      join: () =>
        state.service.joinRoom(
          parseJoinRoomRequest({
            clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398445',
            operationId: crypto.randomUUID(),
            roomCode: '001204',
            profile: { characterId: 'blonde-buns', variant: false },
          }),
        ),
      cancel: () =>
        state.service.cancelRoom(parseCancelRoomRequest({ roomId: ROOM_ID, seatToken: TOKEN })),
      resume: () =>
        state.service.resumeRoom(parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: TOKEN })),
      connect: () =>
        state.service.connectSeat({
          auth: parseSocketAuth({
            executionId: crypto.randomUUID(),
            connectionIntent: 'enter',
            roomId: ROOM_ID,
            seatToken: TOKEN,
            contract,
          }),
          connectedAt: 2_000,
          connectionId: 'creator',
        }),
      sync: () => state.service.syncRoom({ roomId: ROOM_ID, seatIndex: 0 }),
      command: () =>
        state.service
          .executeGameCommand({
            roomId: ROOM_ID,
            seatIndex: 0,
            command: parseGameCommand({
              type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
              actionId: crypto.randomUUID(),
            }),
            receivedAt: 2_000,
          })
          .then((value) => value.result),
    };
    const result = requests[operation]();
    try {
      expect(await result).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED },
      });
      expect(state.repository.getById(ROOM_ID)).toBe(previous);
      expect(state.connections.get(ROOM_ID, 0)).toBeUndefined();
      expect(state.connections.get(ROOM_ID, 1)).toBeUndefined();
    } finally {
      gate.resolve();
      await Promise.all([blocker, result]);
      state.service.close();
    }
  },
);

test('expires a waiting recovery request without changing room state', async () => {
  const state = await fixture(new InMemoryRoomTaskQueue({ requestWaitTimeoutMs: 10 }));
  const gate = Promise.withResolvers<void>();
  const blocker = state.queue.run(ROOM_ID, () => gate.promise);
  const previous = state.repository.getById(ROOM_ID);
  try {
    expect(
      await state.service.resumeRoom(parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: TOKEN })),
    ).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED },
    });
    expect(state.repository.getById(ROOM_ID)).toBe(previous);
    expect(state.queue.pendingRequestCount).toBe(0);
  } finally {
    gate.resolve();
    await blocker;
    state.service.close();
  }
});

test('publishes game start before the next queued room operation', async () => {
  const state = await fixture();
  const gate = Promise.withResolvers<void>();
  const blocker = state.queue.run(ROOM_ID, () => gate.promise);
  const joining = state.service.joinRoom(
    parseJoinRoomRequest({
      clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398445',
      operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
      roomCode: '001204',
      profile: { characterId: 'blonde-buns', variant: false },
    }),
  );
  try {
    await Promise.resolve();
    expect(state.queue.pendingRequestCount).toBe(1);
    const next = state.queue.run(ROOM_ID, () => [...state.started]);
    gate.resolve();
    const [joined, publishedBeforeNext] = await Promise.all([joining, next]);
    if (!joined.ok) throw new Error('join failed');
    expect(publishedBeforeNext).toEqual([joined.data.view]);
  } finally {
    gate.resolve();
    await blocker;
    state.service.close();
  }
});

test('publishes game commits with their next deadline already scheduled', async () => {
  const state = await fixture(undefined, {
    execute: async () => ({ ok: true, artifact: rollArtifact() }),
  });
  try {
    await startGame(state);
    expect(state.published[0]).toMatchObject({ publication: { kind: 'started' }, runAt: 62_001 });
    const current = playingRecord(state);
    state.setNow(2_500);
    const rolled = await state.service.executeGameCommand({
      roomId: ROOM_ID,
      seatIndex: 0,
      receivedAt: 2_500,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.ROLL_DICE,
        actionId: crypto.randomUUID(),
        turnId: current.match.currentTurn.id,
      }),
    });
    expect(rolled.result.ok).toBeTrue();
    state.setNow(3_000);
    const score = state.service.executeGameCommand({
      roomId: ROOM_ID,
      seatIndex: 0,
      receivedAt: 3_000,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
        actionId: crypto.randomUUID(),
        turnId: current.match.currentTurn.id,
        categoryId: 'ones',
      }),
    });
    const next = state.queue.run(ROOM_ID, () => state.scheduled.get(ROOM_ID)?.runAt);
    expect((await score).result.ok).toBeTrue();
    expect(await next).toBe(63_001);
    expect(state.published.at(-1)).toMatchObject({
      publication: { kind: 'game', view: { game: { stateVersion: 3 } } },
      runAt: 63_001,
    });
  } finally {
    state.service.close();
  }
});

test('disconnect and reconnect publish the earliest remaining deadline before returning', async () => {
  const state = await fixture();
  const connect = (seatToken: string, connectionId: string, connectedAt: number) =>
    state.service.connectSeat({
      auth: parseSocketAuth({
        executionId: crypto.randomUUID(),
        connectionIntent: 'enter',
        roomId: ROOM_ID,
        seatToken,
        contract,
      }),
      connectedAt,
      connectionId,
    });
  try {
    await startGame(state);
    expect((await connect(TOKEN, 'creator', 2_100)).ok).toBeTrue();
    expect((await connect(JOINER_TOKEN, 'joiner', 2_200)).ok).toBeTrue();
    const current = playingRecord(state);
    state.repository.replace(ROOM_ID, {
      ...current,
      match: {
        ...current.match,
        currentTurn: { ...current.match.currentTurn, deadlineAt: epochMilliseconds(200_000) },
      },
    });
    expect(
      await state.service.disconnectSeat({
        roomId: ROOM_ID,
        seatIndex: 0,
        connectionId: 'creator',
        disconnectedAt: 6_000,
      }),
    ).toBeTrue();
    expect(state.published.at(-1)).toMatchObject({
      publication: { kind: 'presence' },
      runAt: 96_001,
    });
    expect(
      await state.service.disconnectSeat({
        roomId: ROOM_ID,
        seatIndex: 1,
        connectionId: 'joiner',
        disconnectedAt: 7_000,
      }),
    ).toBeTrue();
    expect(state.published.at(-1)?.runAt).toBe(96_001);
    expect((await connect(TOKEN, 'creator-return', 8_000)).ok).toBeTrue();
    expect(state.published.at(-1)?.runAt).toBe(97_001);
    expect((await connect(JOINER_TOKEN, 'joiner-return', 9_000)).ok).toBeTrue();
    expect(state.published.at(-1)?.runAt).toBe(200_001);
    expect(state.scheduled.get(ROOM_ID)?.runAt).toBe(200_001);
    expect(playingRecord(state).stateVersion).toBe(1);
  } finally {
    state.service.close();
  }
});

test.each([61_000, 62_000])('an early deadline wake at %d rearms without a commit', async (now) => {
  const state = await fixture();
  try {
    await startGame(state);
    const before = playingRecord(state);
    state.setNow(now);
    await state.runDeadline();
    expect(playingRecord(state)).toBe(before);
    expect(state.published).toHaveLength(1);
    expect(state.scheduled.get(ROOM_ID)?.runAt).toBe(62_001);
  } finally {
    state.service.close();
  }
});

test('a failed deadline store rearms and a later wake publishes the next turn', async () => {
  const state = await fixture();
  try {
    await startGame(state);
    const before = playingRecord(state);
    state.setNow(62_001);
    const replace = spyOn(state.repository, 'replace').mockReturnValueOnce(false);
    try {
      await state.runDeadline();
      expect(playingRecord(state)).toBe(before);
      expect(state.published).toHaveLength(1);
      expect(state.scheduled.get(ROOM_ID)?.runAt).toBe(62_001);
    } finally {
      replace.mockRestore();
    }
    await state.runDeadline();
    expect(playingRecord(state).match.players[0].timeoutCount).toBe(1);
    expect(playingRecord(state).stateVersion).toBe(2);
    expect(state.published.at(-1)).toMatchObject({ publication: { kind: 'game' }, runAt: 122_002 });
    expect(state.scheduled.get(ROOM_ID)?.runAt).toBe(122_002);
  } finally {
    state.service.close();
  }
});

test('duplicate, rejected and private-ledger commands keep the active deadline reservation', async () => {
  const state = await fixture(undefined, {
    execute: async () => ({ ok: false, reason: 'unavailable' }),
  });
  try {
    await startGame(state);
    const before = state.scheduled.get(ROOM_ID);
    const command = parseGameCommand({
      type: GAME_COMMAND_TYPE.ROLL_DICE,
      actionId: crypto.randomUUID(),
      turnId: playingRecord(state).match.currentTurn.id,
    });
    state.setNow(3_000);
    for (const seatIndex of [1, 1, 0] as const) {
      expect(
        (
          await state.service.executeGameCommand({
            roomId: ROOM_ID,
            seatIndex,
            receivedAt: 3_000,
            command,
          })
        ).result.ok,
      ).toBeFalse();
      expect(state.scheduled.get(ROOM_ID)).toBe(before);
      expect(state.published).toHaveLength(1);
    }
    expect(playingRecord(state).stateVersion).toBe(1);
  } finally {
    state.service.close();
  }
});

test('close still releases scheduler reservations after the queue disposer fails', async () => {
  const state = await fixture();
  const failure = new Error('queue close failure');
  const closeQueue = spyOn(state.queue, 'close').mockImplementationOnce(() => {
    throw failure;
  });
  state.service.startMaintenance();
  try {
    expect(() => state.service.close()).toThrow(failure);
    expect(state.scheduled.size).toBe(0);
    state.service.startMaintenance();
    expect(state.scheduled.size).toBe(0);
  } finally {
    closeQueue.mockRestore();
    state.service.close();
  }
});

test('close allows an in-flight roll commit without reviving a deadline reservation', async () => {
  const entered = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<RollCommandExecution>();
  const state = await fixture(undefined, {
    execute: () => {
      entered.resolve();
      return completed.promise;
    },
  });
  try {
    await startGame(state);
    state.setNow(3_000);
    const command = state.service.executeGameCommand({
      roomId: ROOM_ID,
      seatIndex: 0,
      receivedAt: 3_000,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.ROLL_DICE,
        actionId: crypto.randomUUID(),
        turnId: playingRecord(state).match.currentTurn.id,
      }),
    });
    await entered.promise;
    state.service.close();
    expect(state.scheduled.size).toBe(0);
    completed.resolve({ ok: true, artifact: rollArtifact() });
    expect((await command).result.ok).toBeTrue();
    expect(playingRecord(state).stateVersion).toBe(2);
    expect(state.published.at(-1)).toMatchObject({ publication: { kind: 'game' }, runAt: null });
    expect(state.scheduled.size).toBe(0);
    expect(state.pending.totalCount()).toBe(0);
  } finally {
    completed.resolve({ ok: false, reason: 'unavailable' });
    state.service.close();
  }
});

test('finished and removed rooms cancel their deadline and make an old wake harmless', async () => {
  const state = await fixture();
  try {
    await startGame(state);
    const wake = state.scheduled.get(ROOM_ID);
    if (wake === undefined) throw new Error('deadline missing');
    state.setNow(3_001);
    const finished = await state.service.executeGameCommand({
      roomId: ROOM_ID,
      seatIndex: 0,
      receivedAt: 3_000,
      command: parseGameCommand({
        type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
        actionId: crypto.randomUUID(),
      }),
    });
    expect(finished.result.ok).toBeTrue();
    expect(state.published.at(-1)).toMatchObject({
      publication: { kind: 'game', view: { room: { status: 'finished' } } },
      runAt: null,
    });
    await wake.task();
    expect(state.scheduled.has(ROOM_ID)).toBeFalse();
    expect(state.published).toHaveLength(2);
    await state.service.cleanupRooms();
    expect(state.repository.getById(ROOM_ID)).toBeUndefined();
    await wake.task();
    expect(state.scheduled.has(ROOM_ID)).toBeFalse();
    expect(state.published).toHaveLength(2);
  } finally {
    state.service.close();
  }
});

test('publishes only public start state once for duplicate join operations', async () => {
  const state = await fixture();
  state.setNow(2_000);
  const request = parseJoinRoomRequest({
    clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398445',
    operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
    roomCode: '001204',
    profile: { characterId: 'blonde-buns', variant: false },
  });
  const [first, second] = await Promise.all([
    state.service.joinRoom(request),
    state.service.joinRoom(request),
  ]);
  expect(first).toEqual(second);
  if (!first.ok) throw new Error('join failed');
  expect(state.started).toEqual([first.data.view]);
  expect(state.scheduled.has(ROOM_ID)).toBeTrue();
  state.service.startMaintenance();
  expect(state.scheduled.size).toBe(2);
  state.service.close();
  expect(state.scheduled.size).toBe(0);
  state.service.startMaintenance();
  expect(state.scheduled.size).toBe(0);
});

test.each(['cancel', 'cleanup'] as const)(
  '%s removes associated connection and pending resources',
  async (operation) => {
    const state = await fixture();
    const connected = await state.service.connectSeat({
      auth: parseSocketAuth({
        executionId: crypto.randomUUID(),
        connectionIntent: 'enter',
        roomId: ROOM_ID,
        seatToken: TOKEN,
        contract,
      }),
      connectedAt: 2_000,
      connectionId: 'creator',
    });
    expect(connected.ok).toBeTrue();
    const completion = Promise.withResolvers<ExecuteGameCommandResult>();
    const pending = state.pending.run(ROOM_ID, 'action', 'fingerprint', () => completion.promise);
    expect(state.pending.count(ROOM_ID)).toBe(1);
    if (operation === 'cancel') {
      expect(
        (
          await state.service.cancelRoom(
            parseCancelRoomRequest({ roomId: ROOM_ID, seatToken: TOKEN }),
          )
        ).ok,
      ).toBeTrue();
    } else {
      state.setNow(301_000);
      await state.service.cleanupRooms();
    }
    expect(state.repository.counts()).toEqual({ rooms: 0, codes: 0 });
    expect(state.connections.get(ROOM_ID, 0)).toBeUndefined();
    expect(state.connections.get(ROOM_ID, 1)).toBeUndefined();
    expect(state.pending.count(ROOM_ID)).toBe(0);
    expect(state.scheduled.has(ROOM_ID)).toBeFalse();
    completion.resolve({
      result: { ok: false, error: { code: PUBLIC_ERROR_CODE.MATCH_FINISHED, params: {} } },
      committedStateVersion: null,
    });
    await pending;
    state.service.close();
  },
);
