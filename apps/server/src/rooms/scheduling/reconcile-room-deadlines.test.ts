import { parseCreateRoomRequest, parseJoinRoomRequest } from '@repo/game-protocol/http';
import type { SeatIndex } from '@repo/yacht-rules';
import { describe, expect, spyOn, test } from 'bun:test';

import { executeCreateRoom } from '@/rooms/admission/create-room';
import { CreateRoomRateLimiter } from '@/rooms/admission/create-room-rate-limit';
import { executeJoinRoom } from '@/rooms/admission/join-room';
import { RoomStateCommitter } from '@/rooms/commit';
import { deadlineTime } from '@/rooms/domain/event-time';
import { forfeitMatch, type PlayingMatch } from '@/rooms/domain/match';
import { disconnectSeat, resumeSeat } from '@/rooms/domain/presence';
import { nextRoomDeadline } from '@/rooms/domain/room-deadlines';
import { finishRoomMatch } from '@/rooms/domain/room-lifecycle';
import { type Room, roomId } from '@/rooms/domain/room-model';
import { isPlayingRoomState } from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';
import type { PlayingRoomRecord } from '@/rooms/record';
import { InMemoryRoomRepository } from '@/rooms/repository';
import { CleanupRoomsUseCase } from '@/rooms/scheduling/cleanup-rooms';
import { RoomDeadlineScheduler } from '@/rooms/scheduling/deadline-scheduler';
import { reconcileRoomDeadlines } from '@/rooms/scheduling/reconcile-room-deadlines';
import { InMemoryRoomTaskQueue } from '@/rooms/scheduling/room-task-queue';
import type { TaskScheduler } from '@/runtime/task-scheduler';

const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const CREATOR_SEAT_INDEX = 0 as const;
const JOINER_SEAT_INDEX = 1 as const;
const TURN_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398441';
const NEXT_TURN_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398442';

class ManualTaskScheduler implements TaskScheduler {
  public readonly tasks: Map<string, { runAt: number; task: () => void | Promise<void> }> =
    new Map();

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

async function playingFixture(): Promise<PlayingRoomRecord> {
  const repository = new InMemoryRoomRepository();
  const queue = new InMemoryRoomTaskQueue();
  const identity = {
    createRequestId: () => '018f47f2-c2d8-7f4a-8bf4-3f559c398444',
    createRoomCodeCandidate: () => '001204',
    createRoomId: () => ROOM_ID,
    createSeatToken: () => 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91',
    createTurnId: () => TURN_ID,
  };
  const created = executeCreateRoom(
    {
      request: parseCreateRoomRequest({
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        operationId: '4ba1e7d4-c077-4b80-b198-9b1f04c182c8',
        profile: { characterId: 'navy-bob', variant: false },
      }),
      ipAddress: '192.0.2.1',
    },
    {
      clock: { now: () => 1_000 },
      identity,
      rateLimiter: new CreateRoomRateLimiter(),
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 1_000 },
        publishRoomState: () => undefined,
      }),
    },
  );
  if (!created.ok) throw new Error('create fixture failed');
  const joined = await executeJoinRoom(
    parseJoinRoomRequest({
      clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398445',
      operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
      roomCode: '001204',
      profile: { characterId: 'blonde-buns', variant: false },
    }),
    {
      clock: { now: () => 2_000 },
      identity: {
        ...identity,
        createSeatToken: () => '9207e571-a39a-49d5-a75f-a08d5e52cce8',
      },
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 2_000 },
        publishRoomState: () => undefined,
      }),
    },
  );
  if (!joined.ok) throw new Error('join fixture failed');
  const record = repository.getById(roomId(ROOM_ID));
  if (record === undefined || !isPlayingRoomState(record)) {
    throw new Error('playing fixture missing');
  }
  const creatorConnected = resumeSeat(record.room, {
    seatIndex: CREATOR_SEAT_INDEX,
    resumedAt: 2_100,
  });
  if (!creatorConnected.ok) throw new Error('creator connect fixture failed');
  const joinerConnected = resumeSeat(creatorConnected.room, {
    seatIndex: JOINER_SEAT_INDEX,
    resumedAt: 2_200,
  });
  if (!joinerConnected.ok || joinerConnected.room.status !== 'playing') {
    throw new Error('joiner connect fixture failed');
  }
  return { ...record, room: joinerConnected.room };
}

test('game commit finalizes a finished aggregate and preserves authority without mutating input', async () => {
  const current = { ...(await playingFixture()), stateVersion: 16 };
  const transition = forfeitMatch(current.match, { forfeitingSeatIndex: 0 });
  if (!transition.ok || transition.match.status !== 'finished') {
    throw new Error('forfeit fixture failed');
  }
  const actionLedger: PlayingRoomRecord['actionLedger'] = [];
  const finishedState = finishRoomMatch(current, transition.match, 3_000);
  if (!finishedState.ok) throw new Error('finish fixture failed');
  const repository = new InMemoryRoomRepository();
  expect(repository.createExclusive(current)).toEqual({ ok: true });
  const committed = new RoomStateCommitter({
    clock: { now: () => 3_000 },
    repository,
    publishRoomState: () => undefined,
  }).commitGame({ current, state: finishedState.state, actionLedger });
  expect(committed.ok).toBeTrue();
  const finished = repository.getById(current.room.id);
  if (finished?.room.status !== 'finished') throw new Error('finished commit missing');
  expect(finished?.room.status).toBe('finished');
  expect(Number(finished?.room.finishedAt)).toBe(3_000);
  expect(finished?.match).toBe(transition.match);
  expect(finished?.credentialHashes).toEqual(current.credentialHashes);
  expect(finished?.actionLedger).toBe(actionLedger);
  expect(finished?.stateVersion).toBe(17);
  expect(finished?.presenceVersion).toBe(current.presenceVersion);
  expect(current.room.status).toBe('playing');
  expect(current.match.status).toBe('playing');
});

function withTurn(
  record: PlayingRoomRecord,
  deadlineAt: number,
  timeoutCount: 0 | 1 | 2 | 3 = 0,
): PlayingRoomRecord {
  const players: PlayingMatch['players'] = [
    { ...record.match.players[0], timeoutCount },
    record.match.players[1],
  ];
  return {
    ...record,
    match: {
      ...record.match,
      players,
      currentTurn: { ...record.match.currentTurn, deadlineAt: epochMilliseconds(deadlineAt) },
    },
  };
}

function disconnect(
  record: PlayingRoomRecord,
  targetSeatIndex: SeatIndex,
  detectedAt: number,
): PlayingRoomRecord {
  const result = disconnectSeat(record.room, {
    seatIndex: targetSeatIndex,
    detectedAt,
  });
  if (!result.ok || !result.changed) {
    throw new Error('disconnect fixture failed');
  }
  if (isPlayingLifecycleRoom(result.room)) {
    return { ...record, room: result.room };
  }
  throw new Error('disconnect fixture returned an invalid lifecycle');
}

function isPlayingLifecycleRoom(room: Room): room is PlayingRoomRecord['room'] {
  return room.status === 'playing';
}

describe('reconcileRoomDeadlines', () => {
  test.each([
    {
      path: 'unchanged',
      deadlineAt: 10_000,
      checkedAt: 9_999,
      timeoutCount: 0,
      offline: false,
      ids: 0,
      ending: null,
    },
    {
      path: 'earlier connection end',
      deadlineAt: 100_000,
      checkedAt: 100_000,
      timeoutCount: 0,
      offline: true,
      ids: 0,
      ending: 'connectionEnded',
    },
    {
      path: 'next turn',
      deadlineAt: 10_000,
      checkedAt: 10_000,
      timeoutCount: 0,
      offline: false,
      ids: 1,
      ending: null,
    },
    {
      path: 'terminal timeout',
      deadlineAt: 10_000,
      checkedAt: 10_000,
      timeoutCount: 2,
      offline: false,
      ids: 1,
      ending: 'timeoutLimit',
    },
    {
      path: 'timeout before connection end',
      deadlineAt: 10_000,
      checkedAt: 95_000,
      timeoutCount: 0,
      offline: true,
      ids: 1,
      ending: 'connectionEnded',
    },
  ] as const)('allocates $ids turn identities for $path', async (scenario) => {
    const playing = withTurn(await playingFixture(), scenario.deadlineAt, scenario.timeoutCount);
    const record = scenario.offline ? disconnect(playing, CREATOR_SEAT_INDEX, 3_000) : playing;
    let identities = 0;

    const result = reconcileRoomDeadlines(record, {
      time: deadlineTime(scenario.checkedAt),
      committedAt: scenario.checkedAt,
      identity: {
        createTurnId: () => {
          identities += 1;
          return NEXT_TURN_ID;
        },
      },
    });

    expect(identities).toBe(scenario.ids);
    if (scenario.ending === null) {
      expect(result.state.match.status).toBe('playing');
    } else {
      expect(result.state.match).toMatchObject({
        status: 'finished',
        result: { reason: scenario.ending },
      });
    }
  });

  test('leaves the playing state unchanged when room finalization rejects its commit time', async () => {
    const record = withTurn(await playingFixture(), 10_000, 2);
    let identities = 0;
    const result = reconcileRoomDeadlines(record, {
      time: deadlineTime(10_000),
      committedAt: 1_999,
      identity: {
        createTurnId: () => {
          identities += 1;
          return NEXT_TURN_ID;
        },
      },
    });

    expect(identities).toBe(1);
    expect(result.changed).toBeFalse();
    expect(result.state.room).toBe(record.room);
    expect(result.state.match).toBe(record.match);
    expect(record.match.players[0].timeoutCount).toBe(2);
  });

  test('finishes a third timeout while both seats are disconnected', async () => {
    const record = disconnect(
      disconnect(withTurn(await playingFixture(), 10_000, 2), 0, 3_000),
      1,
      3_100,
    );
    const result = reconcileRoomDeadlines(record, {
      time: deadlineTime(10_000),
      committedAt: 10_100,
      identity: { createTurnId: () => NEXT_TURN_ID },
    });
    expect(result).toMatchObject({
      changed: true,
      state: {
        room: {
          status: 'finished',
          finishedAt: 10_100,
        },
        match: { status: 'finished', result: { reason: 'timeoutLimit' } },
      },
    });
    expect(record.match.status).toBe('playing');
  });

  test('ends for the earlier reconnect deadline before a later turn timeout', async () => {
    const record = disconnect(withTurn(await playingFixture(), 100_000), JOINER_SEAT_INDEX, 1_000);
    expect(nextRoomDeadline(record)).toBe(91_000);
    const result = reconcileRoomDeadlines(record, {
      time: deadlineTime(91_000),
      committedAt: 91_100,
      identity: { createTurnId: () => NEXT_TURN_ID },
    });

    expect(result).toMatchObject({
      changed: true,
      state: {
        match: {
          status: 'finished',
          result: { reason: 'connectionEnded', winnerSeatIndex: CREATOR_SEAT_INDEX },
        },
      },
    });
  });

  test('third timeout wins an exact tie with reconnect expiry', async () => {
    const record = disconnect(
      withTurn(await playingFixture(), 100_000, 2),
      CREATOR_SEAT_INDEX,
      10_000,
    );
    const result = reconcileRoomDeadlines(record, {
      time: deadlineTime(100_000),
      committedAt: 100_100,
      identity: { createTurnId: () => NEXT_TURN_ID },
    });

    expect(result).toMatchObject({
      changed: true,
      state: {
        match: {
          status: 'finished',
          result: { reason: 'timeoutLimit', winnerSeatIndex: JOINER_SEAT_INDEX },
        },
      },
    });
  });

  test('retains the timeout fact before connection end when a nonterminal timeout ties', async () => {
    const record = disconnect(
      withTurn(await playingFixture(), 100_000),
      CREATOR_SEAT_INDEX,
      10_000,
    );
    const result = reconcileRoomDeadlines(record, {
      time: deadlineTime(100_000),
      committedAt: 100_100,
      identity: { createTurnId: () => NEXT_TURN_ID },
    });

    expect(result).toMatchObject({
      changed: true,
      state: {
        match: {
          status: 'finished',
          players: [{ timeoutCount: 1 }, { timeoutCount: 0 }],
          result: { reason: 'connectionEnded', winnerSeatIndex: JOINER_SEAT_INDEX },
        },
      },
    });
  });

  test('ends both-disconnected play at the earliest deadline even when seat one expired first', async () => {
    const first = disconnect(withTurn(await playingFixture(), 200_000), JOINER_SEAT_INDEX, 10_000);
    const both = disconnect(first, CREATOR_SEAT_INDEX, 70_000);
    expect(nextRoomDeadline(both)).toBe(100_000);
    expect(both.room.status).toBe('playing');
    const result = reconcileRoomDeadlines(both, {
      time: deadlineTime(170_000),
      committedAt: 170_100,
      identity: { createTurnId: () => NEXT_TURN_ID },
    });
    expect(result).toMatchObject({
      changed: true,
      state: {
        match: {
          status: 'finished',
          result: { reason: 'connectionEnded', winnerSeatIndex: CREATOR_SEAT_INDEX },
        },
      },
    });
  });

  test('continues the current turn timer while both seats are disconnected', async () => {
    const first = disconnect(withTurn(await playingFixture(), 90_000), CREATOR_SEAT_INDEX, 10_000);
    const both = disconnect(first, JOINER_SEAT_INDEX, 20_000);
    expect(nextRoomDeadline(both)).toBe(Number(both.match.currentTurn.deadlineAt));

    const result = reconcileRoomDeadlines(both, {
      time: deadlineTime(90_000),
      committedAt: 90_100,
      identity: { createTurnId: () => NEXT_TURN_ID },
    });

    expect(result).toMatchObject({
      changed: true,
      state: {
        room: { status: 'playing' },
        match: {
          status: 'playing',
          players: [{ timeoutCount: 1 }, { timeoutCount: 0 }],
          currentTurn: { seatIndex: JOINER_SEAT_INDEX, deadlineAt: 150_100 },
        },
      },
    });
  });

  test('finishes simultaneous offline deadlines once and removes the room after adjudication', async () => {
    const baseline = disconnect(
      disconnect(withTurn(await playingFixture(), 200_000), 0, 3_000),
      1,
      3_000,
    );
    const repository = new InMemoryRoomRepository();
    repository.createExclusive(baseline);
    const tasks = new ManualTaskScheduler();
    let now = 92_999;
    const updates: unknown[] = [];
    const scheduler = new RoomDeadlineScheduler({
      clock: { now: () => now },
      identity: { createTurnId: () => NEXT_TURN_ID },
      queue: new InMemoryRoomTaskQueue(),
      repository,
      tasks,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => now },
        publishRoomState: (publication) => {
          scheduler.reconcile(publication.roomId);
          if (publication.kind === 'game') updates.push(publication.update.view.game);
        },
      }),
    });
    scheduler.reconcile(baseline.room.id);
    expect(tasks.tasks.get(String(baseline.room.id))?.runAt).toBe(93_001);
    const cleanup = new CleanupRoomsUseCase({
      clock: { now: () => now },
      queue: new InMemoryRoomTaskQueue(),
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => now },
        publishRoomState: () => undefined,
        onRemoved: (id) => scheduler.reconcile(id),
      }),
    });
    await cleanup.execute();
    expect(repository.getById(baseline.room.id)).toBe(baseline);
    now = 93_001;
    await tasks.run(String(baseline.room.id));
    expect(updates).toHaveLength(1);
    expect(repository.getById(baseline.room.id)?.match).toMatchObject({
      status: 'finished',
      result: { reason: 'connectionEnded' },
    });
    expect(tasks.tasks.size).toBe(0);
    await cleanup.execute();
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
    await cleanup.execute();
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
    tasks.close();
  });

  test('schedules, commits, publishes, and re-registers the next turn deadline', async () => {
    const record = await playingFixture();
    const repository = new InMemoryRoomRepository();
    expect(repository.createExclusive(record)).toEqual({ ok: true });
    const tasks = new ManualTaskScheduler();
    const updates: number[] = [];
    let now = 3_000;
    const scheduler = new RoomDeadlineScheduler({
      clock: { now: () => now },
      identity: { createTurnId: () => NEXT_TURN_ID },
      queue: new InMemoryRoomTaskQueue(),
      repository,
      tasks,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => now },
        publishRoomState: (publication) => {
          scheduler.reconcile(publication.roomId);
          if (publication.kind === 'game') updates.push(publication.update.view.game!.stateVersion);
        },
      }),
    });

    scheduler.reconcile(roomId(ROOM_ID));
    expect(tasks.tasks.get(ROOM_ID)?.runAt).toBe(62_001);

    now = 62_001;
    await tasks.run(ROOM_ID);

    expect(repository.getById(roomId(ROOM_ID))).toMatchObject({
      stateVersion: 2,
      match: {
        status: 'playing',
        players: [{ timeoutCount: 1 }, { timeoutCount: 0 }],
        currentTurn: { seatIndex: JOINER_SEAT_INDEX, deadlineAt: 122_001 },
      },
    });
    expect(updates).toEqual([2]);
    expect(tasks.tasks.get(ROOM_ID)?.runAt).toBe(122_002);
  });

  test('rearms the deadline after storage failure without advancing state or publishing', async () => {
    const record = await playingFixture();
    const repository = new InMemoryRoomRepository();
    expect(repository.createExclusive(record)).toEqual({ ok: true });
    const replace = spyOn(repository, 'replace').mockReturnValue(false);
    const tasks = new ManualTaskScheduler();
    let publications = 0;
    const clock = { now: () => 62_001 };
    const scheduler = new RoomDeadlineScheduler({
      clock,
      identity: { createTurnId: () => NEXT_TURN_ID },
      queue: new InMemoryRoomTaskQueue(),
      repository,
      tasks,
      commits: new RoomStateCommitter({
        repository,
        clock,
        publishRoomState: () => {
          publications += 1;
        },
      }),
    });
    scheduler.reconcile(record.room.id);

    try {
      await tasks.run(ROOM_ID);
      expect(replace).toHaveBeenCalledTimes(1);
      expect(repository.getById(record.room.id)).toBe(record);
      expect(publications).toBe(0);
      expect(tasks.tasks.get(ROOM_ID)?.runAt).toBe(62_001);
    } finally {
      replace.mockRestore();
    }
  });

  test('uses queue execution time for one timeout after a long delayed callback', async () => {
    const record = await playingFixture();
    const repository = new InMemoryRoomRepository();
    expect(repository.createExclusive(record)).toEqual({ ok: true });
    const queue = new InMemoryRoomTaskQueue();
    const tasks = new ManualTaskScheduler();
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const running = queue.run(record.room.id, () => {
      entered.resolve();
      return gate.promise;
    });
    await entered.promise;
    let now = 62_001;
    let identities = 0;
    const updates: number[] = [];
    const scheduler = new RoomDeadlineScheduler({
      clock: { now: () => now },
      identity: {
        createTurnId: () => {
          identities += 1;
          return NEXT_TURN_ID;
        },
      },
      queue,
      repository,
      tasks,
      commits: new RoomStateCommitter({
        repository,
        clock: { now: () => now },
        publishRoomState: (publication) => {
          scheduler.reconcile(publication.roomId);
          if (publication.kind === 'game') updates.push(publication.update.view.game!.stateVersion);
        },
      }),
    });
    scheduler.reconcile(record.room.id);
    const wake = tasks.run(ROOM_ID);
    expect(repository.getById(record.room.id)).toBe(record);

    now = 250_000;
    gate.resolve();
    await Promise.all([running, wake]);

    expect(repository.getById(record.room.id)).toMatchObject({
      stateVersion: 2,
      match: {
        status: 'playing',
        players: [{ timeoutCount: 1 }, { timeoutCount: 0 }],
        currentTurn: { seatIndex: JOINER_SEAT_INDEX, startedAt: 250_000, deadlineAt: 310_000 },
      },
    });
    expect(identities).toBe(1);
    expect(updates).toEqual([2]);
    expect(tasks.tasks.get(ROOM_ID)?.runAt).toBe(310_001);
  });

  test.each([61_000, 62_000])(
    'does not adjudicate an unclosed deadline millisecond at %d',
    async (now) => {
      const record = await playingFixture();
      const repository = new InMemoryRoomRepository();
      expect(repository.createExclusive(record)).toEqual({ ok: true });
      const tasks = new ManualTaskScheduler();
      const scheduler = new RoomDeadlineScheduler({
        clock: { now: () => now },
        identity: { createTurnId: () => NEXT_TURN_ID },
        queue: new InMemoryRoomTaskQueue(),
        repository,
        tasks,
        commits: new RoomStateCommitter({
          repository: repository,
          clock: { now: () => now },
          publishRoomState: () => {
            throw new Error('early callback must not publish');
          },
        }),
      });
      scheduler.reconcile(roomId(ROOM_ID));

      await tasks.run(ROOM_ID);

      expect(repository.getById(roomId(ROOM_ID))?.stateVersion).toBe(1);
      expect(tasks.tasks.get(ROOM_ID)?.runAt).toBe(62_001);
    },
  );
});
