import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomRequest, parseJoinRoomRequest } from '@repo/game-protocol/http';
import type { SeatIndex } from '@repo/yacht-rules';
import { describe, expect, test } from 'bun:test';

import { executeCreateRoom } from '@/rooms/admission/create-room';
import { CreateRoomRateLimiter } from '@/rooms/admission/create-room-rate-limit';
import { executeJoinRoom } from '@/rooms/admission/join-room';
import { RoomStateCommitter } from '@/rooms/commit';
import { forfeitMatch, MATCH_END_REASON } from '@/rooms/domain/match';
import { markGameFinished } from '@/rooms/domain/room-lifecycle';
import { roomId } from '@/rooms/domain/room-model';
import { isPlayingRoomState } from '@/rooms/domain/room-state';
import type { FinishedRoomRecord } from '@/rooms/record';
import { InMemoryRoomRepository } from '@/rooms/repository';
import { InMemoryRoomTaskQueue } from '@/rooms/scheduling/room-task-queue';
import { executeSyncRoom } from '@/rooms/sync-room';

const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const CREATOR_SEAT_INDEX = 0 as const;
const JOINER_SEAT_INDEX = 1 as const;
const FOREIGN_SEAT_INDEX = 2 as SeatIndex;
const TURN_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398442';

interface FixtureState {
  readonly queue: InMemoryRoomTaskQueue;
  readonly repository: InMemoryRoomRepository;
}

function seedWaiting(): FixtureState {
  const repository = new InMemoryRoomRepository();
  const created = executeCreateRoom(
    {
      request: parseCreateRoomRequest({
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398443',
        operationId: '4ba1e7d4-c077-4b80-b198-9b1f04c182c8',
        profile: { characterId: 'navy-bob', variant: false },
      }),
      ipAddress: '192.0.2.1',
    },
    {
      clock: { now: () => 1_000 },
      identity: {
        createRoomCodeCandidate: () => '001204',
        createRoomId: () => ROOM_ID,
        createSeatToken: () => 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91',
      },
      rateLimiter: new CreateRoomRateLimiter(),
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 1_000 },
        publishRoomState: () => undefined,
      }),
    },
  );
  if (!created.ok) throw new Error('create fixture failed');
  return { queue: new InMemoryRoomTaskQueue(), repository };
}

async function seedPlaying(): Promise<FixtureState> {
  const state = seedWaiting();
  const joined = await executeJoinRoom(
    parseJoinRoomRequest({
      clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398446',
      operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
      roomCode: '001204',
      profile: { characterId: 'blonde-buns', variant: false },
    }),
    {
      clock: { now: () => 2_000 },
      identity: {
        createSeatToken: () => '9207e571-a39a-49d5-a75f-a08d5e52cce8',
        createTurnId: () => TURN_ID,
      },
      queue: state.queue,
      repository: state.repository,
      commits: new RoomStateCommitter({
        repository: state.repository,
        clock: { now: () => 2_000 },
        publishRoomState: () => undefined,
      }),
    },
  );
  if (!joined.ok) throw new Error('join fixture failed');
  return state;
}

const unavailableCases = [
  {
    label: 'missing room',
    setup: () => Promise.resolve(seedWaiting()),
    requestedRoomId: roomId('018f47f2-c2d8-7f4a-8bf4-3f559c398450'),
    requestedSeatIndex: CREATOR_SEAT_INDEX,
  },
  {
    label: 'foreign seat',
    setup: seedPlaying,
    requestedRoomId: roomId(ROOM_ID),
    requestedSeatIndex: FOREIGN_SEAT_INDEX,
  },
] as const;

describe('executeSyncRoom', () => {
  test.each(unavailableCases.map((scenario) => [scenario.label, scenario] as const))(
    'returns safe resume error for %s',
    async (_label, scenario) => {
      const state = await scenario.setup();

      await expect(
        executeSyncRoom(
          { roomId: scenario.requestedRoomId, seatIndex: scenario.requestedSeatIndex },
          state,
        ),
      ).resolves.toEqual({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, params: {} },
      });
    },
  );

  test('returns waiting presence with a null game for the creator seat', async () => {
    const state = seedWaiting();

    const result = await executeSyncRoom(
      { roomId: roomId(ROOM_ID), seatIndex: CREATOR_SEAT_INDEX },
      state,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        room: {
          status: 'waiting',
          roomId: ROOM_ID,
          roomCode: '001204',
          createdAt: 1_000,
          expiresAt: 301_000,
          seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
        },
        game: null,
        presence: {
          roomId: ROOM_ID,
          seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
        },
      },
    });
  });

  test.each([CREATOR_SEAT_INDEX, JOINER_SEAT_INDEX])(
    'returns the same public room profiles and snapshots to authorized seat %s',
    async (seatIndex) => {
      const state = await seedPlaying();
      const current = state.repository.getById(roomId(ROOM_ID));
      if (current === undefined || !isPlayingRoomState(current)) {
        throw new Error('playing fixture missing');
      }
      state.repository.replace(roomId(ROOM_ID), {
        ...current,
        stateVersion: 7,
        presenceVersion: 11,
      });

      const result = await executeSyncRoom({ roomId: roomId(ROOM_ID), seatIndex }, state);

      expect(result).toMatchObject({
        ok: true,
        data: {
          room: {
            status: 'playing',
            roomId: ROOM_ID,
            roomCode: '001204',
            createdAt: 1_000,
            startedAt: 2_000,
            seats: [
              { profile: { characterId: 'navy-bob', variant: false } },
              { profile: { characterId: 'blonde-buns', variant: false } },
            ],
          },
          game: {
            stateVersion: 7,
            match: {
              status: 'playing',
              players: [
                {
                  scorecard: {},
                  timeoutCount: 0,
                },
                {
                  scorecard: {},
                  timeoutCount: 0,
                },
              ],
              currentTurn: {
                turnId: TURN_ID,
                seatIndex: CREATOR_SEAT_INDEX,
                rollCount: 0,
                dice: null,
              },
            },
          },
          presence: {
            roomId: ROOM_ID,
            presenceVersion: 11,
            seats: [
              { status: 'disconnected', reconnectDeadlineAt: null },
              { status: 'disconnected', reconnectDeadlineAt: null },
            ],
          },
        },
      });
    },
  );

  test('returns the final game snapshot without a turn for an authorized finished seat', async () => {
    const state = await seedPlaying();
    const current = state.repository.getById(roomId(ROOM_ID));
    if (current === undefined || !isPlayingRoomState(current)) {
      throw new Error('playing fixture missing');
    }
    const transition = forfeitMatch(current.match, {
      forfeitingSeatIndex: JOINER_SEAT_INDEX,
    });
    const finishedRoom = markGameFinished(current.room, { finishedAt: 3_000 });
    if (!transition.ok || transition.match.status !== 'finished') {
      throw new Error('match finish fixture failed');
    }
    if (!finishedRoom.ok || !finishedRoom.changed || finishedRoom.room.status !== 'finished') {
      throw new Error('room finish fixture failed');
    }
    const finished: FinishedRoomRecord = {
      ...current,
      room: finishedRoom.room,
      match: transition.match,
      stateVersion: 8,
      presenceVersion: 12,
    };
    state.repository.replace(roomId(ROOM_ID), finished);

    const result = await executeSyncRoom(
      { roomId: roomId(ROOM_ID), seatIndex: CREATOR_SEAT_INDEX },
      state,
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        room: {
          status: 'finished',
          roomId: ROOM_ID,
          roomCode: '001204',
          createdAt: 1_000,
          startedAt: 2_000,
          finishedAt: 3_000,
          seats: [
            { profile: { characterId: 'navy-bob', variant: false } },
            { profile: { characterId: 'blonde-buns', variant: false } },
          ],
        },
        game: {
          stateVersion: 8,
          match: {
            status: 'finished',
            result: {
              reason: MATCH_END_REASON.EXPLICIT_FORFEIT,
              winnerSeatIndex: CREATOR_SEAT_INDEX,
            },
          },
        },
        presence: { roomId: ROOM_ID, presenceVersion: 12 },
      },
    });
    if (!result.ok || result.data.game === null) throw new Error('expected sync success');
    expect(result.data.game.match).not.toHaveProperty('currentTurn');
  });

  test('observes a queued replacement before projecting the sync snapshot', async () => {
    const state = await seedPlaying();
    const barrier = Promise.withResolvers<void>();
    const replacement = state.queue.run(roomId(ROOM_ID), async () => {
      await barrier.promise;
      const current = state.repository.getById(roomId(ROOM_ID));
      if (current === undefined) throw new Error('playing fixture missing');
      state.repository.replace(roomId(ROOM_ID), {
        ...current,
        stateVersion: 13,
        presenceVersion: 17,
      });
    });
    const sync = executeSyncRoom({ roomId: roomId(ROOM_ID), seatIndex: CREATOR_SEAT_INDEX }, state);

    barrier.resolve();
    const [, result] = await Promise.all([replacement, sync]);

    expect(result).toMatchObject({
      ok: true,
      data: {
        game: { stateVersion: 13 },
        presence: { presenceVersion: 17 },
      },
    });
  });
});
