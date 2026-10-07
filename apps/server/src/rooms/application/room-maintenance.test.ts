import { parseCancelRoomRequest, parseJoinRoomRequest } from '@repo/game-protocol/http';
import { describe, expect, spyOn, test } from 'bun:test';

import { executeCancelRoom } from '@/rooms/application/admission/cancel-room';
import { executeJoinRoom } from '@/rooms/application/admission/join-room';
import { hashSeatToken, seatTokenHash } from '@/rooms/application/connections/seat-token';
import { RoomMaintenance } from '@/rooms/application/room-maintenance';
import type { PlayingRoomRecord, WaitingRoomRecord } from '@/rooms/application/room-record';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import { InMemoryRoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { createMatch, turnId } from '@/rooms/domain/match';
import { PRESENCE_STATUS } from '@/rooms/domain/room-constants';
import { type RoomId, roomId } from '@/rooms/domain/room-model';
import { epochMilliseconds } from '@/rooms/domain/time';

const ROOM_ID = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39843e');

function waitingRecord(): WaitingRoomRecord {
  const created = createRoom({
    roomId: ROOM_ID,
    code: '001204',
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!created.ok) throw new Error('fixture create failed');
  return {
    actionLedger: [],
    room: created.room,
    match: null,
    credentialHashes: [seatTokenHash('a'.repeat(64))],
    stateVersion: 0,
    presenceVersion: 0,
  };
}

function bothDisconnectedRecord(): PlayingRoomRecord {
  const waiting = waitingRecord();
  const joined = joinRoom(waiting.room, {
    characterId: 'blonde-buns',
    variant: false,
    joinedAt: 2_000,
  });
  if (!joined.ok) throw new Error('fixture join failed');
  const match = createMatch({
    initialTurn: {
      id: turnId('018f47f2-c2d8-7f4a-8bf4-3f559c398441'),
      startedAt: epochMilliseconds(2_000),
    },
  });
  return {
    actionLedger: waiting.actionLedger,
    room: {
      ...joined.room,
      seats: [
        {
          ...joined.room.seats[0],
          presence: {
            status: PRESENCE_STATUS.DISCONNECTED,
            reconnectDeadlineAt: epochMilliseconds(94_000),
          },
        },
        {
          ...joined.room.seats[1],
          presence: {
            status: PRESENCE_STATUS.DISCONNECTED,
            reconnectDeadlineAt: epochMilliseconds(94_000),
          },
        },
      ],
    },
    match,
    credentialHashes: [waiting.credentialHashes[0], seatTokenHash('b'.repeat(64))],
    stateVersion: 1,
    presenceVersion: 2,
  };
}

describe('RoomMaintenance', () => {
  test('compacts idle expired results in FIFO without removing retry identity or live results', async () => {
    const repository = new InMemoryRoomRepository();
    const queue = new InMemoryRoomTaskQueue();
    const record: PlayingRoomRecord = {
      ...bothDisconnectedRecord(),
      actionLedger: [
        {
          status: 'completed',
          seatIndex: 0,
          actionId: 'expired',
          fingerprint: 'same',
          expiresAt: 5_000,
          result: { ok: true, stateVersion: 1 },
        },
        {
          status: 'completed',
          seatIndex: 0,
          actionId: 'live',
          fingerprint: 'live',
          expiresAt: 6_000,
          result: { ok: true, stateVersion: 1 },
        },
        { status: 'retryable', seatIndex: 1, actionId: 'retry', fingerprint: 'retry' },
      ],
    };
    repository.createExclusive(record);
    const gate = Promise.withResolvers<void>();
    const prior = queue.runRequest(ROOM_ID, async () => {
      await gate.promise;
      repository.replace(ROOM_ID, { ...record, stateVersion: 2 });
    });
    const cleanup = new RoomMaintenance({
      clock: { now: () => 5_000 },
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 5_000 },
        publishRoomState: () => undefined,
      }),
    }).execute();
    gate.resolve();
    await Promise.all([prior, cleanup]);
    const retained = repository.getById(ROOM_ID);
    expect(retained?.actionLedger).toEqual([
      { status: 'tombstone', seatIndex: 0, actionId: 'expired', fingerprint: 'same' },
      record.actionLedger[1],
      record.actionLedger[2],
    ]);
    expect(retained?.stateVersion).toBe(2);
    expect(retained?.presenceVersion).toBe(record.presenceVersion);
    expect(retained?.match).toBe(record.match);
    expect(repository.counts()).toEqual({ rooms: 1, codes: 1 });
  });

  test('removes an expired waiting record and every index exactly once', async () => {
    const repository = new InMemoryRoomRepository();
    repository.createExclusive(waitingRecord());
    const removed: RoomId[] = [];
    const useCase = new RoomMaintenance({
      clock: { now: () => 301_000 },
      queue: new InMemoryRoomTaskQueue(),
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 301_000 },
        publishRoomState: () => undefined,
        onRemoved: (removedRoomId) => removed.push(removedRoomId),
      }),
    });

    await useCase.execute();
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
    await useCase.execute();
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
    expect(removed).toEqual([ROOM_ID]);
  });

  test('shares one in-flight cleanup promise', async () => {
    const repository = new InMemoryRoomRepository();
    repository.createExclusive(waitingRecord());
    const useCase = new RoomMaintenance({
      clock: { now: () => 301_000 },
      queue: new InMemoryRoomTaskQueue(),
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 301_000 },
        publishRoomState: () => undefined,
      }),
    });

    const first = useCase.execute();
    const second = useCase.execute();

    expect(second).toBe(first);
    await first;
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
  });

  test('keeps a failed sweep in flight until every candidate finishes', async () => {
    const repository = new InMemoryRoomRepository();
    const queue = new InMemoryRoomTaskQueue();
    const secondId = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39844a');
    const firstRecord = waitingRecord();
    const secondRecord = createRoom({
      roomId: secondId,
      code: '001205',
      characterId: 'navy-bob',
      variant: false,
      createdAt: 1_000,
    });
    if (!secondRecord.ok) throw new Error('fixture create failed');
    repository.createExclusive(firstRecord);
    repository.createExclusive({
      ...firstRecord,
      room: { ...firstRecord.room, id: secondId, code: secondRecord.room.code },
    });
    const gate = Promise.withResolvers<void>();
    const prior = queue.run(secondId, () => gate.promise);
    const failure = new Error('cleanup failed');
    const failed = Promise.withResolvers<void>();
    const commits = new RoomStateCommitter({
      repository,
      clock: { now: () => 301_000 },
      publishRoomState: () => undefined,
    });
    const originalRemove = commits.remove.bind(commits);
    const remove = spyOn(commits, 'remove').mockImplementation((record) => {
      if (record.room.id !== ROOM_ID) return originalRemove(record);
      failed.resolve();
      throw failure;
    });
    const useCase = new RoomMaintenance({
      clock: { now: () => 301_000 },
      queue,
      repository,
      commits,
    });
    const first = useCase.execute();
    let settled = false;
    const observed = first.then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await failed.promise;
      await Bun.sleep(0);
      expect(settled).toBeFalse();
      expect(useCase.execute()).toBe(first);
      gate.resolve();
      await prior;
      expect(await observed).toBe(failure);
      expect(repository.getById(secondId)).toBeUndefined();
      remove.mockRestore();
      const next = useCase.execute();
      expect(next).not.toBe(first);
      await next;
      expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
    } finally {
      gate.resolve();
      await Promise.allSettled([prior, first]);
      remove.mockRestore();
      queue.close();
    }
  });

  test('preserves the first observed rejection when the first candidate fails later', async () => {
    const repository = new InMemoryRoomRepository();
    const firstRecord = waitingRecord();
    const secondId = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39844a');
    const second = createRoom({
      roomId: secondId,
      code: '001205',
      characterId: 'navy-bob',
      variant: false,
      createdAt: 1_000,
    });
    if (!second.ok) throw new Error('fixture create failed');
    repository.createExclusive(firstRecord);
    repository.createExclusive({ ...firstRecord, room: second.room });
    const queue = new InMemoryRoomTaskQueue();
    const gate = Promise.withResolvers<void>();
    const prior = queue.run(ROOM_ID, () => gate.promise);
    const earlierFailure = new Error('second candidate failed first');
    const laterFailure = new Error('first candidate failed later');
    const failed = Promise.withResolvers<void>();
    const useCase = new RoomMaintenance({
      clock: { now: () => 301_000 },
      queue,
      repository,
      commits: {
        commitLedger: () => {
          throw new Error('unexpected ledger commit');
        },
        remove: (record) => {
          if (record.room.id === ROOM_ID) throw laterFailure;
          failed.resolve();
          throw earlierFailure;
        },
      },
    });
    const sweep = useCase.execute();
    const observed = sweep.catch((error: unknown) => error);
    try {
      await failed.promise;
      await Bun.sleep(0);
      expect(useCase.execute()).toBe(sweep);
      gate.resolve();
      await prior;
      expect(await observed).toBe(earlierFailure);
    } finally {
      gate.resolve();
      await Promise.allSettled([prior, sweep]);
      queue.close();
    }
  });

  test('waits for later queue registrations after a synchronous undefined rejection', async () => {
    const queue = new InMemoryRoomTaskQueue();
    const secondId = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39844a');
    const gate = Promise.withResolvers<void>();
    const prior = queue.run(secondId, () => gate.promise);
    const run = queue.run.bind(queue);
    const registered: RoomId[] = [];
    const failure: unknown = undefined;
    const registration = spyOn(queue, 'run').mockImplementation((id, operation) => {
      registered.push(id);
      if (id === ROOM_ID) throw failure;
      return run(id, operation);
    });
    const repository = new InMemoryRoomRepository();
    const candidates = spyOn(repository, 'listMaintenanceCandidateRoomIds').mockReturnValue([
      ROOM_ID,
      secondId,
    ]);
    const useCase = new RoomMaintenance({
      clock: { now: () => 301_000 },
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository,
        clock: { now: () => 301_000 },
        publishRoomState: () => undefined,
      }),
    });
    const sweep = useCase.execute();
    let settled = false;
    const observed = sweep
      .then(
        () => ({ rejected: false }),
        (error: unknown) => ({ rejected: true, error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      expect(registered).toEqual([ROOM_ID, secondId]);
      await Bun.sleep(0);
      expect(settled).toBeFalse();
      expect(useCase.execute()).toBe(sweep);
      gate.resolve();
      await prior;
      expect(await observed).toEqual({ rejected: true, error: undefined });
    } finally {
      gate.resolve();
      await Promise.allSettled([prior, sweep]);
      registration.mockRestore();
      candidates.mockRestore();
      queue.close();
    }
  });

  test('skips a candidate already removed by cancellation ahead in the room queue', async () => {
    const repository = new InMemoryRoomRepository();
    const queue = new InMemoryRoomTaskQueue();
    const token = '550e8400-e29b-41d4-a716-446655440000';
    repository.createExclusive({ ...waitingRecord(), credentialHashes: [hashSeatToken(token)] });
    const removed: RoomId[] = [];
    const useCase = new RoomMaintenance({
      clock: { now: () => 301_000 },
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 301_000 },
        publishRoomState: () => undefined,
        onRemoved: (id) => removed.push(id),
      }),
    });
    const cancelled = executeCancelRoom(
      parseCancelRoomRequest({ roomId: ROOM_ID, seatToken: token }),
      {
        repository,
        queue,
        commits: new RoomStateCommitter({
          repository: repository,
          clock: { now: () => 0 },
          publishRoomState: () => undefined,
        }),
      },
    );
    const cleanup = useCase.execute();
    expect(await cancelled).toEqual({ ok: true, data: { cancelled: true } });
    await cleanup;
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
    expect(removed).toEqual([]);
  });

  test('retains a waiting candidate that starts playing ahead of cleanup in the room queue', async () => {
    const repository = new InMemoryRoomRepository();
    const queue = new InMemoryRoomTaskQueue();
    const waiting = waitingRecord();
    repository.createExclusive(waiting);
    const gate = Promise.withResolvers<void>();
    const prior = queue.run(ROOM_ID, () => gate.promise);
    const joined = executeJoinRoom(
      parseJoinRoomRequest({
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        operationId: '4ba1e7d4-c077-4b80-b198-9b1f04c182c8',
        roomCode: '001204',
        profile: { characterId: 'blonde-buns', variant: false },
      }),
      {
        clock: { now: () => 300_999 },
        identity: {
          createSeatToken: () => '550e8400-e29b-41d4-a716-446655440000',
          createTurnId: () => '018f47f2-c2d8-7f4a-8bf4-3f559c398441',
        },
        queue,
        repository,
        commits: new RoomStateCommitter({
          repository: repository,
          clock: { now: () => 300_999 },
          publishRoomState: () => undefined,
        }),
      },
    );
    const removed: RoomId[] = [];
    const cleanup = new RoomMaintenance({
      clock: { now: () => 301_000 },
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 301_000 },
        publishRoomState: () => undefined,
        onRemoved: (id) => removed.push(id),
      }),
    }).execute();
    gate.resolve();
    const [, result] = await Promise.all([prior, joined, cleanup]);
    expect(result.ok).toBeTrue();
    expect(repository.getById(ROOM_ID)).toMatchObject({
      room: { status: 'playing' },
      stateVersion: 1,
    });
    expect(repository.findRoomIdByCode(waiting.room.code)).toBe(ROOM_ID);
    expect(removed).toEqual([]);
  });

  test('does not select or remove both-disconnected play during reconnect grace', async () => {
    const repository = new InMemoryRoomRepository();
    const record = bothDisconnectedRecord();
    repository.createExclusive(record);
    const useCase = new RoomMaintenance({
      clock: { now: () => 93_999 },
      queue: new InMemoryRoomTaskQueue(),
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 93_999 },
        publishRoomState: () => undefined,
      }),
    });
    await useCase.execute();
    expect(repository.getById(ROOM_ID)).toBe(record);
  });
});
