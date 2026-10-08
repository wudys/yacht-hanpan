import type { SeatIndex } from '@repo/yacht-rules';
import { describe, expect, test } from 'bun:test';

import { reconcileRoomDeadlines } from '@/rooms/application/reconcile-room-deadlines';
import {
  CREATOR_SEAT_INDEX,
  JOINER_SEAT_INDEX,
  ManualTaskScheduler,
  NEXT_TURN_ID,
  playingFixture,
} from '@/rooms/application/room-deadlines.test-fixtures';
import { RoomMaintenance } from '@/rooms/application/room-maintenance';
import type { PlayingRoomRecord } from '@/rooms/application/room-record';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import { RoomDeadlineScheduler } from '@/rooms/application/scheduling/deadline-scheduler';
import { InMemoryRoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { deadlineTime } from '@/rooms/domain/event-time';
import type { PlayingMatch } from '@/rooms/domain/match';
import { disconnectSeat } from '@/rooms/domain/presence';
import { nextRoomDeadline } from '@/rooms/domain/room-deadlines';
import type { Room } from '@/rooms/domain/room-model';
import { epochMilliseconds } from '@/rooms/domain/time';

function withTurn(
  record: PlayingRoomRecord,
  deadlineAt: number,
  timeoutCount: 0 | 1 | 2 = 0,
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
      timeoutCount: 1,
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
    const record = withTurn(await playingFixture(), 10_000, 1);
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
    expect(record.match.players[0].timeoutCount).toBe(1);
  });

  test('finishes a second timeout while both seats are disconnected', async () => {
    const record = disconnect(
      disconnect(withTurn(await playingFixture(), 10_000, 1), 0, 3_000),
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

  test('second timeout wins an exact tie with reconnect expiry', async () => {
    const record = disconnect(
      withTurn(await playingFixture(), 100_000, 1),
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
          currentTurn: { seatIndex: JOINER_SEAT_INDEX, deadlineAt: 180_100 },
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
    const cleanup = new RoomMaintenance({
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
});
