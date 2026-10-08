import { describe, expect, spyOn, test } from 'bun:test';

import {
  JOINER_SEAT_INDEX,
  ManualTaskScheduler,
  NEXT_TURN_ID,
  playingFixture,
  ROOM_ID,
} from '@/rooms/application/room-deadlines.test-fixtures';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import { RoomDeadlineScheduler } from '@/rooms/application/scheduling/deadline-scheduler';
import { InMemoryRoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { roomId } from '@/rooms/domain/room-model';

describe('RoomDeadlineScheduler', () => {
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
    expect(tasks.tasks.get(ROOM_ID)?.runAt).toBe(92_001);

    now = 92_001;
    await tasks.run(ROOM_ID);

    expect(repository.getById(roomId(ROOM_ID))).toMatchObject({
      stateVersion: 2,
      match: {
        status: 'playing',
        players: [{ timeoutCount: 1 }, { timeoutCount: 0 }],
        currentTurn: { seatIndex: JOINER_SEAT_INDEX, deadlineAt: 182_001 },
      },
    });
    expect(updates).toEqual([2]);
    expect(tasks.tasks.get(ROOM_ID)?.runAt).toBe(182_002);
  });

  test('rearms the deadline after storage failure without advancing state or publishing', async () => {
    const record = await playingFixture();
    const repository = new InMemoryRoomRepository();
    expect(repository.createExclusive(record)).toEqual({ ok: true });
    const replace = spyOn(repository, 'replace').mockReturnValue(false);
    const tasks = new ManualTaskScheduler();
    let publications = 0;
    const clock = { now: () => 92_001 };
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
      expect(tasks.tasks.get(ROOM_ID)?.runAt).toBe(92_001);
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
    const running = queue.runInternal(record.room.id, () => {
      entered.resolve();
      return gate.promise;
    });
    await entered.promise;
    let now = 92_001;
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
        currentTurn: { seatIndex: JOINER_SEAT_INDEX, startedAt: 250_000, deadlineAt: 340_000 },
      },
    });
    expect(identities).toBe(1);
    expect(updates).toEqual([2]);
    expect(tasks.tasks.get(ROOM_ID)?.runAt).toBe(340_001);
  });

  test.each([91_000, 92_000])(
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
      expect(tasks.tasks.get(ROOM_ID)?.runAt).toBe(92_001);
    },
  );
});
