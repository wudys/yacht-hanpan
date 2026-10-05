import { parseResumeRoomRequest } from '@repo/game-protocol/http';
import { parseSocketAuth } from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { executeResumeRoom } from '@/rooms/application/admission/resume-room';
import { executeConnectSeat } from '@/rooms/application/connections/connect-seat';
import { ConnectionRegistry } from '@/rooms/application/connections/connection-registry';
import { hashSeatToken } from '@/rooms/application/connections/seat-token';
import { reconcileRoomDeadlines } from '@/rooms/application/reconcile-room-deadlines';
import { RoomMaintenance } from '@/rooms/application/room-maintenance';
import type { PlayingRoomRecord, RoomRecord } from '@/rooms/application/room-record';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import { InMemoryRoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { createRoom } from '@/rooms/domain/create-room';
import { deadlineTime } from '@/rooms/domain/event-time';
import { joinRoom } from '@/rooms/domain/join-room';
import { createMatch, turnId } from '@/rooms/domain/match';
import { disconnectSeat, resumeSeat } from '@/rooms/domain/presence';
import { roomId } from '@/rooms/domain/room-model';
import { isPlayingRoomState } from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';

const ROOM_ID = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39843e');
const TOKENS = [
  'd9428888-122b-4d34-8f6f-1f0f4f7f6b91',
  '9207e571-a39a-49d5-a75f-a08d5e52cce8',
] as const;
const contract = createCompatibilityContract('test-release');
const identity = { createTurnId: () => '018f47f2-c2d8-7f4a-8bf4-3f559c398443' };

function bothDisconnected(): PlayingRoomRecord {
  const created = createRoom({
    roomId: ROOM_ID,
    code: '001204',
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!created.ok) throw new Error('create fixture failed');
  const joined = joinRoom(created.room, {
    characterId: 'blonde-buns',
    variant: false,
    joinedAt: 2_000,
  });
  if (!joined.ok) throw new Error('join fixture failed');
  const creator = resumeSeat(joined.room, { seatIndex: 0, resumedAt: 2_100 });
  if (!creator.ok) throw new Error('connect fixture failed');
  const joiner = resumeSeat(creator.room, { seatIndex: 1, resumedAt: 2_200 });
  if (!joiner.ok) throw new Error('connect fixture failed');
  const first = disconnectSeat(joiner.room, { seatIndex: 0, detectedAt: 3_000 });
  if (!first.ok) throw new Error('disconnect fixture failed');
  const second = disconnectSeat(first.room, { seatIndex: 1, detectedAt: 63_000 });
  if (!second.ok || second.room.status !== 'playing') throw new Error('disconnect fixture failed');
  const initial = createMatch({
    initialTurn: {
      id: turnId('018f47f2-c2d8-7f4a-8bf4-3f559c398442'),
      startedAt: epochMilliseconds(2_000),
    },
  });
  const afterTimeout = reconcileRoomDeadlines(
    {
      room: second.room,
      match: {
        ...initial,
        currentTurn: { ...initial.currentTurn, deadlineAt: epochMilliseconds(62_000) },
      },
    },
    { time: deadlineTime(62_000), committedAt: 62_000, identity },
  );
  if (!isPlayingRoomState(afterTimeout.state)) throw new Error('timeout fixture failed');
  return {
    ...afterTimeout.state,
    actionLedger: [],
    credentialHashes: [hashSeatToken(TOKENS[0]), hashSeatToken(TOKENS[1])],
    stateVersion: 2,
    presenceVersion: 4,
  };
}

function dependencies(record: RoomRecord, now: number) {
  const repository = new InMemoryRoomRepository();
  repository.createExclusive(record);
  return {
    repository,
    queue: new InMemoryRoomTaskQueue(),
    clock: { now: () => now },
    connections: new ConnectionRegistry(),
    expectedContract: contract,
    commits: new RoomStateCommitter({
      repository: repository,
      clock: { now: () => now },
      publishRoomState: () => undefined,
    }),
  };
}

describe('shared reconnect lifecycle', () => {
  test.each([92_999, 93_000, 93_001])(
    'HTTP and socket admission respect the earliest seat deadline at %d',
    async (now) => {
      const record = bothDisconnected();
      const state = dependencies(record, now);
      const request = parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: TOKENS[1] });
      const http = await executeResumeRoom(request, state);
      expect(http.ok).toBe(now < 93_000);
      expect(state.repository.getById(ROOM_ID)).toBe(record);
      const socket = await executeConnectSeat(
        {
          auth: parseSocketAuth({
            executionId: crypto.randomUUID(),
            connectionIntent: 'enter',
            ...request,
            contract,
          }),
          connectedAt: now,
          connectionId: 'returning',
        },
        state,
      );
      expect(socket.ok).toBe(now < 93_000);
      expect(state.connections.get(ROOM_ID, 1) !== undefined).toBe(now < 93_000);
      expect(state.connections.get(ROOM_ID, 0)).toBeUndefined();
      if (now >= 93_000) expect(state.repository.getById(ROOM_ID)).toBe(record);
    },
  );

  test('an early return preserves the absent peer deadline and cleanup waits for adjudication', async () => {
    const state = dependencies(bothDisconnected(), 88_000);
    const returned = await executeConnectSeat(
      {
        auth: parseSocketAuth({
          executionId: crypto.randomUUID(),
          connectionIntent: 'enter',
          roomId: ROOM_ID,
          seatToken: TOKENS[0],
          contract,
        }),
        connectedAt: 88_000,
        connectionId: 'creator',
      },
      state,
    );
    expect(returned.ok).toBeTrue();
    const record = state.repository.getById(ROOM_ID);
    if (record?.room.status !== 'playing' || record.match?.status !== 'playing')
      throw new Error('playing record missing');
    expect(record.room.seats[1].presence).toMatchObject({ reconnectDeadlineAt: 153_000 });
    const cleanup = new RoomMaintenance(state);
    await cleanup.execute();
    expect(state.repository.getById(ROOM_ID)).toBe(record);
    const before = await executeResumeRoom(
      parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: TOKENS[1] }),
      { ...state, clock: { now: () => 152_999 } },
    );
    expect(before.ok).toBeTrue();
    const after = await executeResumeRoom(
      parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: TOKENS[1] }),
      { ...state, clock: { now: () => 153_000 } },
    );
    expect(after.ok).toBeFalse();
  });

  test('does not expose a finished offline match through HTTP or socket before cleanup', async () => {
    const current = bothDisconnected();
    const ended = reconcileRoomDeadlines(current, {
      time: deadlineTime(93_000),
      committedAt: 93_001,
      identity,
    });
    expect(ended.state.match.status).toBe('finished');
    const state = dependencies({ ...current, ...ended.state, stateVersion: 3 }, 93_002);
    const request = parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: TOKENS[1] });
    expect((await executeResumeRoom(request, state)).ok).toBeFalse();
    expect(
      (
        await executeConnectSeat(
          {
            auth: parseSocketAuth({
              executionId: crypto.randomUUID(),
              connectionIntent: 'enter',
              ...request,
              contract,
            }),
            connectedAt: 93_002,
            connectionId: 'finished',
          },
          state,
        )
      ).ok,
    ).toBeFalse();
    expect(state.connections.get(ROOM_ID, 0)).toBeUndefined();
    expect(state.connections.get(ROOM_ID, 1)).toBeUndefined();
    const cleanup = new RoomMaintenance(state);
    await cleanup.execute();
    expect(state.repository.getById(ROOM_ID)).toBeUndefined();
  });

  for (const seatIndex of [0, 1] as const) {
    for (const timeoutCount of [0, 1] as const) {
      test.each([89_999, 90_000, 90_001])(
        `delayed scheduler admission agrees for seat ${seatIndex}, timeout count ${timeoutCount}, at %d`,
        async (now) => {
          const baseline = bothDisconnected();
          const record: PlayingRoomRecord = {
            ...baseline,
            match: {
              ...baseline.match,
              players: [baseline.match.players[0], { ...baseline.match.players[1], timeoutCount }],
              currentTurn: { ...baseline.match.currentTurn, deadlineAt: epochMilliseconds(90_000) },
            },
          };
          const state = dependencies(record, now);
          const request = parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: TOKENS[seatIndex] });
          const allowed = timeoutCount < 1 || now < 90_000;
          expect((await executeResumeRoom(request, state)).ok).toBe(allowed);
          expect(state.repository.getById(ROOM_ID)).toBe(record);
          expect(
            (
              await executeConnectSeat(
                {
                  auth: parseSocketAuth({
                    executionId: crypto.randomUUID(),
                    connectionIntent: 'enter',
                    ...request,
                    contract,
                  }),
                  connectedAt: now,
                  connectionId: 'returning',
                },
                state,
              )
            ).ok,
          ).toBe(allowed);
          const after = state.repository.getById(ROOM_ID);
          expect(after?.match).toBe(record.match);
          expect(after?.stateVersion).toBe(record.stateVersion);
          expect(state.connections.get(ROOM_ID, seatIndex) !== undefined).toBe(allowed);
          expect(state.connections.get(ROOM_ID, seatIndex === 0 ? 1 : 0)).toBeUndefined();
          if (!allowed) expect(after).toBe(record);
        },
      );
    }
  }

  test('rechecks a terminal deadline at Socket admission after an earlier successful HTTP query', async () => {
    const baseline = bothDisconnected();
    const record: PlayingRoomRecord = {
      ...baseline,
      match: {
        ...baseline.match,
        players: [baseline.match.players[0], { ...baseline.match.players[1], timeoutCount: 1 }],
        currentTurn: { ...baseline.match.currentTurn, deadlineAt: epochMilliseconds(90_000) },
      },
    };
    const state = dependencies(record, 89_999);
    const request = parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: TOKENS[0] });
    expect((await executeResumeRoom(request, state)).ok).toBeTrue();
    expect(
      (
        await executeConnectSeat(
          {
            auth: parseSocketAuth({
              executionId: crypto.randomUUID(),
              connectionIntent: 'enter',
              ...request,
              contract,
            }),
            connectedAt: 90_000,
            connectionId: 'too-late',
          },
          state,
        )
      ).ok,
    ).toBeFalse();
    expect(state.repository.getById(ROOM_ID)).toBe(record);
    expect(state.connections.get(ROOM_ID, 0)).toBeUndefined();
    expect(state.connections.get(ROOM_ID, 1)).toBeUndefined();
  });
});
