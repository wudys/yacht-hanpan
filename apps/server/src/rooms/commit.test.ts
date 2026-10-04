import { DICE_SIMULATION_CONTRACT, POUR_STYLE } from '@repo/dice-simulation/contract';
import { parseResolvedRollArtifact } from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { describe, expect, spyOn, test } from 'bun:test';

import { reserveRetryableAction } from '@/rooms/commands/action-ledger';
import { RoomStateCommitter, type RoomStatePublication } from '@/rooms/commit';
import { ConnectionRegistry } from '@/rooms/connections/connection-registry';
import { executeDisconnectSeat } from '@/rooms/connections/disconnect-seat';
import { hashSeatToken, verifySeatToken } from '@/rooms/connections/seat-token';
import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { createMatch, forfeitMatch, turnId } from '@/rooms/domain/match';
import { resumeSeat } from '@/rooms/domain/presence';
import { markGameFinished } from '@/rooms/domain/room-lifecycle';
import { roomId } from '@/rooms/domain/room-model';
import type { PlayingRoomState } from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';
import type { PlayingRoomRecord, WaitingRoomRecord } from '@/rooms/record';
import { InMemoryRoomRepository } from '@/rooms/repository';
import { InMemoryRoomTaskQueue } from '@/rooms/scheduling/room-task-queue';

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
    room: created.room,
    match: null,
    stateVersion: 0,
    presenceVersion: 0,
    credentialHashes: [hashSeatToken('commit-fixture-creator')],
    actionLedger: [],
  };
}

function playingRecord(): PlayingRoomRecord {
  const waiting = waitingRecord();
  const joined = joinRoom(waiting.room, {
    characterId: 'blonde-buns',
    variant: false,
    joinedAt: 2_000,
  });
  if (!joined.ok) throw new Error('fixture join failed');
  return {
    ...waiting,
    room: joined.room,
    match: createMatch({
      initialTurn: {
        id: turnId('018f47f2-c2d8-7f4a-8bf4-3f559c398441'),
        startedAt: epochMilliseconds(2_000),
      },
    }),
    stateVersion: 1,
    presenceVersion: 1,
    credentialHashes: [waiting.credentialHashes[0], hashSeatToken('commit-fixture-joiner')],
  };
}

function fixture() {
  const repository = new InMemoryRoomRepository();
  const current = playingRecord();
  repository.createExclusive(current);
  const published: RoomStatePublication[] = [];
  const commits = new RoomStateCommitter({
    clock: { now: () => 3_000 },
    repository,
    publishRoomState: (publication) => {
      published.push(publication);
    },
  });
  return { repository, current, published, commits };
}

describe('RoomStateCommitter', () => {
  test('starts with both seat credentials and advances both versions before publication', () => {
    const repository = new InMemoryRoomRepository();
    const current = waitingRecord();
    repository.createExclusive(current);
    const started = playingRecord();
    const publications: RoomStatePublication[] = [];
    const commits = new RoomStateCommitter({
      clock: { now: () => 3_000 },
      repository,
      publishRoomState: (publication) => {
        expect(repository.getById(ROOM_ID)?.stateVersion).toBe(1);
        expect(repository.getById(ROOM_ID)?.presenceVersion).toBe(1);
        publications.push(publication);
      },
    });

    const result = commits.commitStart({
      current,
      state: started,
      guestCredentialHash: started.credentialHashes[1],
    });

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected start success');
    expect(result.committedStateVersion).toBe(1);
    expect(result.record.actionLedger).toBe(current.actionLedger);
    expect(verifySeatToken('commit-fixture-creator', result.record.credentialHashes[0])).toBeTrue();
    expect(verifySeatToken('commit-fixture-joiner', result.record.credentialHashes[1])).toBeTrue();
    expect(publications).toMatchObject([
      {
        kind: 'started',
        view: {
          room: { status: 'playing' },
          game: { stateVersion: 1 },
          presence: { presenceVersion: 1 },
        },
      },
    ]);
    expect(repository.getById(ROOM_ID)).toBe(result.record);
    expect(current.stateVersion).toBe(0);
    expect(current.presenceVersion).toBe(0);
    expect(current.credentialHashes).toHaveLength(1);
  });

  test('a failed start store preserves the waiting record and publishes nothing', () => {
    const repository = new InMemoryRoomRepository();
    const current = waitingRecord();
    repository.createExclusive(current);
    const before = structuredClone(current);
    const replace = spyOn(repository, 'replace').mockReturnValue(false);
    const publishRoomState = () => {
      throw new Error('failed store must not publish');
    };
    const commits = new RoomStateCommitter({
      repository,
      clock: { now: () => 3_000 },
      publishRoomState,
    });
    const started = playingRecord();

    expect(
      commits.commitStart({
        current,
        state: started,
        guestCredentialHash: started.credentialHashes[1],
      }),
    ).toEqual({ ok: false, reason: 'storageFailure' });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(repository.getById(ROOM_ID)).toBe(current);
    expect(repository.getById(ROOM_ID)).toEqual(before);
    expect(current.credentialHashes).toHaveLength(1);
  });

  test('rejects an incoherent start before storage or publication', () => {
    const repository = new InMemoryRoomRepository();
    const current = waitingRecord();
    repository.createExclusive(current);
    const replace = spyOn(repository, 'replace');
    const commits = new RoomStateCommitter({
      repository,
      clock: { now: () => 3_000 },
      publishRoomState: () => {
        throw new Error('invalid start must not publish');
      },
    });
    const started = playingRecord();
    const candidate = { room: started.room, match: null } as unknown as PlayingRoomState;

    expect(() =>
      commits.commitStart({
        current,
        state: candidate,
        guestCredentialHash: started.credentialHashes[1],
      }),
    ).toThrow();
    expect(replace).not.toHaveBeenCalled();
    expect(repository.getById(ROOM_ID)).toBe(current);
  });

  test.each(['playing', 'finished'] as const)(
    'preserves credentials, presence, and ledger when %s state carries extra metadata',
    (status) => {
      const state = fixture();
      const room = markGameFinished(state.current.room, { finishedAt: 3_000 });
      const match = forfeitMatch(state.current.match, { forfeitingSeatIndex: 1 });
      if (!room.ok || !room.changed || !match.ok || match.match.status !== 'finished') {
        throw new Error('finish fixture failed');
      }
      const extraLedger = reserveRetryableAction([], {
        seatIndex: 0,
        actionId: 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
        fingerprint: 'extra-metadata',
      });
      if (extraLedger === null) throw new Error('ledger fixture failed');
      const candidate = {
        ...(status === 'playing'
          ? { room: state.current.room, match: state.current.match }
          : { room: room.room, match: match.match }),
        credentialHashes: [hashSeatToken('extra-creator'), hashSeatToken('extra-joiner')],
        presenceVersion: 90,
        stateVersion: 90,
        actionLedger: extraLedger,
      };

      const result = state.commits.commitGame({ current: state.current, state: candidate });

      expect(result.ok).toBeTrue();
      if (!result.ok) throw new Error('expected game success');
      expect(result.record.room.status).toBe(status);
      expect(result.record.match.status).toBe(status);
      expect(result.record.presenceVersion).toBe(1);
      expect(result.record.stateVersion).toBe(2);
      expect(result.record.actionLedger).toBe(state.current.actionLedger);
      expect(
        verifySeatToken('commit-fixture-creator', result.record.credentialHashes[0]),
      ).toBeTrue();
      expect(
        verifySeatToken('commit-fixture-joiner', result.record.credentialHashes[1]),
      ).toBeTrue();
      expect(state.published).toMatchObject([
        { kind: 'game', view: { game: { stateVersion: 2 }, presence: { presenceVersion: 1 } } },
      ]);
      expect(candidate.presenceVersion).toBe(90);
      expect(candidate.actionLedger).toBe(extraLedger);
      expect(state.current.stateVersion).toBe(1);
      expect(state.current.match.status).toBe('playing');
    },
  );

  test('rejects a lifecycle change through presence without replacing the active connection', () => {
    const state = fixture();
    const finished = markGameFinished(state.current.room, { finishedAt: 3_000 });
    if (!finished.ok || !finished.changed) throw new Error('fixture finish failed');
    const connections = new ConnectionRegistry();
    const previous = { connectionId: 'old-socket', executionId: 'old-execution' };
    connections.bind(ROOM_ID, 0, previous);
    const replace = spyOn(state.repository, 'replace');

    const result = state.commits.commitSeatConnection(
      {
        current: state.current,
        room: finished.room,
        seatIndex: 0,
        connection: { connectionId: 'new-socket', executionId: 'new-execution' },
      },
      connections,
    );

    expect(result).toEqual({ ok: false, reason: 'storageFailure' });
    expect(replace).not.toHaveBeenCalled();
    expect(state.repository.getById(ROOM_ID)).toBe(state.current);
    expect(connections.get(ROOM_ID, 0)).toEqual(previous);
    expect(state.published).toEqual([]);
  });

  test('rejects an incoherent public view before replacing the authoritative record', () => {
    const state = fixture();
    const replace = spyOn(state.repository, 'replace');
    const candidate = { ...state.current, match: null } as unknown as PlayingRoomState;

    expect(() => state.commits.commitGame({ current: state.current, state: candidate })).toThrow();
    expect(replace).not.toHaveBeenCalled();
    expect(state.repository.getById(ROOM_ID)).toBe(state.current);
    expect(state.published).toHaveLength(0);
  });

  test('a failed store neither completes an action nor publishes its candidate view', () => {
    const state = fixture();
    const before = structuredClone(state.current);
    const replace = spyOn(state.repository, 'replace').mockReturnValue(false);

    const result = state.commits.commitGame({
      current: state.current,
      state: state.current,
      completedAction: {
        seatIndex: 0,
        actionId: 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
        fingerprint: 'fixture-action',
        result: { ok: true },
      },
    });

    expect(result).toEqual({ ok: false, reason: 'storageFailure' });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(state.repository.getById(ROOM_ID)).toBe(state.current);
    expect(state.repository.getById(ROOM_ID)).toEqual(before);
    expect(state.published).toHaveLength(0);
  });

  test('publishes the stored game view before the next queued room operation', async () => {
    const state = fixture();
    const queue = new InMemoryRoomTaskQueue();
    const observations: string[] = [];
    const commits = new RoomStateCommitter({
      repository: state.repository,
      clock: { now: () => 3_000 },
      publishRoomState: (publication) => {
        expect(state.repository.getById(ROOM_ID)?.stateVersion).toBe(2);
        expect(Number(publication.view.game?.stateVersion)).toBe(2);
        expect(Number(publication.view.presence.presenceVersion)).toBe(1);
        observations.push('publication');
      },
    });

    const first = queue.run(ROOM_ID, () =>
      commits.commitGame({
        current: state.current,
        state: state.current,
      }),
    );
    const second = queue.run(ROOM_ID, () => {
      observations.push('next operation');
      expect(state.repository.getById(ROOM_ID)?.stateVersion).toBe(2);
    });

    await Promise.all([first, second]);
    expect(observations).toEqual(['publication', 'next operation']);
    expect(state.current.stateVersion).toBe(1);
  });

  test('a connected-seat storage failure leaves the previous binding and public state intact', () => {
    const state = fixture();
    const connections = new ConnectionRegistry();
    const previous = { connectionId: 'old-socket', executionId: 'old-execution' };
    connections.bind(ROOM_ID, 0, previous);
    const transition = resumeSeat(state.current.room, { seatIndex: 0, resumedAt: 3_000 });
    if (!transition.ok) throw new Error('connect fixture failed');
    const before = structuredClone(state.current);
    const replace = spyOn(state.repository, 'replace').mockReturnValue(false);

    const result = state.commits.commitSeatConnection(
      {
        current: state.current,
        room: transition.room,
        seatIndex: 0,
        connection: { connectionId: 'new-socket', executionId: 'new-execution' },
      },
      connections,
    );

    expect(result).toEqual({ ok: false, reason: 'storageFailure' });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(connections.get(ROOM_ID, 0)).toBe(previous);
    expect(state.repository.getById(ROOM_ID)).toBe(state.current);
    expect(state.repository.getById(ROOM_ID)).toEqual(before);
    expect(state.published).toHaveLength(0);
  });

  test('binds the new connected seat before publication and ignores the old transport disconnect', async () => {
    const state = fixture();
    const connections = new ConnectionRegistry();
    connections.bind(ROOM_ID, 0, { connectionId: 'old-socket', executionId: 'old-execution' });
    const transition = resumeSeat(state.current.room, { seatIndex: 0, resumedAt: 3_000 });
    if (!transition.ok) throw new Error('connect fixture failed');
    const commits = new RoomStateCommitter({
      clock: { now: () => 3_000 },
      repository: state.repository,
      publishRoomState: (publication) => {
        expect(connections.get(ROOM_ID, 0)?.connectionId).toBe('new-socket');
        expect(state.repository.getById(ROOM_ID)?.presenceVersion).toBe(2);
        expect(Number(publication.view.game?.stateVersion)).toBe(1);
        state.published.push(publication);
      },
    });
    const result = commits.commitSeatConnection(
      {
        current: state.current,
        room: transition.room,
        seatIndex: 0,
        connection: { connectionId: 'new-socket', executionId: 'new-execution' },
      },
      connections,
    );
    expect(result.ok).toBeTrue();

    const ignored = await executeDisconnectSeat(
      {
        roomId: ROOM_ID,
        seatIndex: 0,
        connectionId: 'old-socket',
        disconnectedAt: 4_000,
      },
      { repository: state.repository, queue: new InMemoryRoomTaskQueue(), connections, commits },
    );

    expect(ignored).toBeFalse();
    expect(state.published).toHaveLength(1);
    expect(state.published[0]?.kind).toBe('presence');
    expect(state.repository.getById(ROOM_ID)?.room.seats[0].presence.status).toBe('connected');
  });

  test('a same-presence connection takeover does not write or publish again', () => {
    const state = fixture();
    const connections = new ConnectionRegistry();
    const transition = resumeSeat(state.current.room, { seatIndex: 0, resumedAt: 3_000 });
    if (!transition.ok) throw new Error('connect fixture failed');
    const first = state.commits.commitSeatConnection(
      {
        current: state.current,
        room: transition.room,
        seatIndex: 0,
        connection: { connectionId: 'old-socket', executionId: 'old-execution' },
      },
      connections,
    );
    if (!first.ok) throw new Error('first connect failed');
    const replace = spyOn(state.repository, 'replace');

    const result = state.commits.commitSeatConnection(
      {
        current: first.record,
        room: first.record.room,
        seatIndex: 0,
        connection: { connectionId: 'new-socket', executionId: 'new-execution' },
      },
      connections,
    );

    expect(result.ok).toBeTrue();
    expect(replace).not.toHaveBeenCalled();
    expect(state.published).toHaveLength(1);
    expect(connections.get(ROOM_ID, 0)?.connectionId).toBe('new-socket');
    expect(state.repository.getById(ROOM_ID)?.presenceVersion).toBe(2);
  });

  test('private action completion retains both public versions without publishing', () => {
    const state = fixture();
    const result = state.commits.commitLedger({
      current: state.current,
      actionLedger: state.current.actionLedger,
      completedAction: {
        seatIndex: 0,
        actionId: 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
        fingerprint: 'fixture-action',
        result: { ok: true },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      committedStateVersion: null,
      actionResult: { ok: true, stateVersion: 1 },
    });
    const stored = state.repository.getById(ROOM_ID);
    expect(stored?.stateVersion).toBe(1);
    expect(stored?.presenceVersion).toBe(1);
    expect(stored?.room).toBe(state.current.room);
    expect(stored?.match).toBe(state.current.match);
    expect(stored?.actionLedger[0]).toMatchObject({ status: 'completed', expiresAt: 303_000 });
    expect(state.published).toHaveLength(0);
  });

  test('rejects a valid roll artifact paired with an unrolled game before storage', () => {
    const state = fixture();
    const replace = spyOn(state.repository, 'replace');
    const roll = parseResolvedRollArtifact({
      type: 'roll:resolved',
      replay: {
        mode: 'seeded-physics',
        rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
        seed: 'ab'.repeat(16),
        pourStyle: POUR_STYLE.CLASSIC,
        rolledSlots: [0, 1, 2, 3, 4],
        contract: createCompatibilityContract('test-release'),
      },
      outcome: { authoritativeValuesBySlot: [0, 1, 2, 3, 4].map((slot) => ({ slot, value: 1 })) },
      replayDigest: `${DICE_SIMULATION_CONTRACT.replayDigestVersion}:${'a'.repeat(64)}`,
    });

    expect(() =>
      state.commits.commitGame({
        current: state.current,
        state: state.current,
        completedAction: {
          seatIndex: 0,
          actionId: 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
          fingerprint: 'fixture-roll',
          result: { ok: true, roll },
        },
      }),
    ).toThrow();

    expect(replace).not.toHaveBeenCalled();
    expect(state.repository.getById(ROOM_ID)).toBe(state.current);
    expect(state.published).toHaveLength(0);
  });

  test('a publisher failure retains the committed state and completed receipt', () => {
    const state = fixture();
    const commits = new RoomStateCommitter({
      repository: state.repository,
      clock: { now: () => 3_000 },
      publishRoomState: () => {
        throw new Error('fixture delivery failure');
      },
    });

    expect(() =>
      commits.commitGame({
        current: state.current,
        state: state.current,
        completedAction: {
          seatIndex: 0,
          actionId: 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
          fingerprint: 'fixture-action',
          result: { ok: true },
        },
      }),
    ).toThrow('fixture delivery failure');

    expect(state.repository.getById(ROOM_ID)).toMatchObject({
      stateVersion: 2,
      actionLedger: [{ status: 'completed', result: { ok: true, stateVersion: 2 } }],
    });
  });

  test('rejects an invalid initial public identity before creating any room or code index', () => {
    const repository = new InMemoryRoomRepository();
    const create = spyOn(repository, 'createExclusive');
    const waiting = waitingRecord();
    const commits = new RoomStateCommitter({
      repository,
      clock: { now: () => 1_000 },
      publishRoomState: () => undefined,
    });

    expect(() =>
      commits.create({
        ...waiting,
        room: { ...waiting.room, id: roomId('fixture-invalid-public-id') },
      }),
    ).toThrow();

    expect(create).not.toHaveBeenCalled();
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
  });

  test('captures a finished view before removal and delivers it after the indexes are gone', () => {
    const state = fixture();
    const room = markGameFinished(state.current.room, { finishedAt: 3_000 });
    const match = forfeitMatch(state.current.match, { forfeitingSeatIndex: 1 });
    if (!room.ok || !room.changed || !match.ok || match.match.status !== 'finished') {
      throw new Error('finish fixture failed');
    }
    const finished = { ...state.current, room: room.room, match: match.match, stateVersion: 2 };
    state.repository.replace(ROOM_ID, finished);
    const removed: unknown[] = [];
    const commits = new RoomStateCommitter({
      clock: { now: () => 4_000 },
      repository: state.repository,
      publishRoomState: (publication) => {
        state.published.push(publication);
      },
      onRemoved: (roomId, view) => {
        expect(roomId).toBe(ROOM_ID);
        expect(state.repository.getById(ROOM_ID)).toBeUndefined();
        expect(state.repository.findRoomIdByCode(finished.room.code)).toBeUndefined();
        removed.push(view);
      },
    });

    expect(commits.remove(finished)).toBeTrue();
    expect(removed).toMatchObject([{ room: { status: 'finished' }, game: { stateVersion: 2 } }]);
    expect(state.published).toHaveLength(0);
  });
});
