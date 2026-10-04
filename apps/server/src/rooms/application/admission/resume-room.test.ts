import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  parseCreateRoomRequest,
  parseJoinRoomRequest,
  parseResumeRoomRequest,
  parseResumeRoomResponse,
} from '@repo/game-protocol/http';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { executeCreateRoom } from '@/rooms/application/admission/create-room';
import { CreateRoomRateLimiter } from '@/rooms/application/admission/create-room-rate-limiter';
import { executeJoinRoom } from '@/rooms/application/admission/join-room';
import {
  executeResumeRoom,
  type ResumeRoomDependencies,
} from '@/rooms/application/admission/resume-room';
import type { PlayingRoomRecord } from '@/rooms/application/room-record';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import { InMemoryRoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { PRESENCE_STATUS, ROOM_STATUS } from '@/rooms/domain/room-constants';
import { roomId } from '@/rooms/domain/room-model';
import { epochMilliseconds } from '@/rooms/domain/time';

const CLIENT_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843d';
const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const SEAT_INDEX = 0 as const;
const TURN_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398442';
const REQUEST_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398440';
const SEAT_TOKEN = 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91';
const JOINER_TOKEN = '9207e571-a39a-49d5-a75f-a08d5e52cce8';

function seedWaiting(repository: InMemoryRoomRepository): void {
  const result = executeCreateRoom(
    {
      request: parseCreateRoomRequest({
        clientId: CLIENT_ID,
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
        createSeatToken: () => SEAT_TOKEN,
      },
      rateLimiter: new CreateRoomRateLimiter(),
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 1_000 },
        publishRoomState: () => undefined,
      }),
    },
  );
  if (!result.ok) throw new Error('fixture create failed');
}

function dependencies(
  repository: InMemoryRoomRepository,
  now: number = 2_000,
): ResumeRoomDependencies {
  return { clock: { now: () => now }, queue: new InMemoryRoomTaskQueue(), repository };
}

describe('executeResumeRoom', () => {
  test('returns waiting state for the creator without echoing the token or mutating presence', async () => {
    const repository = new InMemoryRoomRepository();
    seedWaiting(repository);
    const before = repository.getById(roomId(ROOM_ID));

    const result = await executeResumeRoom(
      parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN }),
      dependencies(repository),
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected resume success');
    expect(
      parseResumeRoomResponse({
        ...result,
        meta: {
          requestId: REQUEST_ID,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
          serverTime: 1000,
        },
      }),
    ).toBeDefined();
    expect(result.data).toMatchObject({ seatIndex: SEAT_INDEX, view: { game: null } });
    expect(JSON.stringify(result)).not.toContain(SEAT_TOKEN);
    expect(repository.getById(roomId(ROOM_ID))).toBe(before);
  });

  test('collapses a wrong token to a safe resume error', async () => {
    const repository = new InMemoryRoomRepository();
    seedWaiting(repository);
    const otherToken = '9207e571-a39a-49d5-a75f-a08d5e52cce8';
    const other = executeCreateRoom(
      {
        request: parseCreateRoomRequest({
          clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398496',
          operationId: 'a6f9fc18-01e4-469c-8382-301e7d85654d',
          profile: { characterId: 'blonde-buns', variant: false },
        }),
        ipAddress: '192.0.2.2',
      },
      {
        clock: { now: () => 1_000 },
        identity: {
          createRoomCodeCandidate: () => '001205',
          createRoomId: () => '018f47f2-c2d8-7f4a-8bf4-3f559c398497',
          createSeatToken: () => otherToken,
        },
        rateLimiter: new CreateRoomRateLimiter(),
        commits: new RoomStateCommitter({
          repository: repository,
          clock: { now: () => 1_000 },
          publishRoomState: () => undefined,
        }),
      },
    );
    if (!other.ok) throw new Error('other-room fixture create failed');

    const result = await executeResumeRoom(
      parseResumeRoomRequest({
        roomId: ROOM_ID,
        seatToken: otherToken,
      }),
      dependencies(repository),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, params: {} },
    });
  });

  test('projects both-disconnected play as playing without changing presence during preflight', async () => {
    const repository = new InMemoryRoomRepository();
    seedWaiting(repository);
    const joined = await executeJoinRoom(
      parseJoinRoomRequest({
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398499',
        operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
        roomCode: '001204',
        profile: { characterId: 'blonde-buns', variant: false },
      }),
      {
        clock: { now: () => 2_000 },
        identity: {
          createSeatToken: () => JOINER_TOKEN,
          createTurnId: () => TURN_ID,
        },
        queue: new InMemoryRoomTaskQueue(),
        repository,
        commits: new RoomStateCommitter({
          repository: repository,
          clock: { now: () => 2_000 },
          publishRoomState: () => undefined,
        }),
      },
    );
    if (!joined.ok) throw new Error('fixture join failed');
    const playing = repository.getById(roomId(ROOM_ID));
    const playingMatch = playing?.match;
    if (
      playing?.room.status !== ROOM_STATUS.PLAYING ||
      playingMatch?.status !== 'playing' ||
      playing.credentialHashes.length !== 2
    ) {
      throw new Error('expected playing fixture');
    }
    const bothDisconnected: PlayingRoomRecord = {
      ...playing,
      match: playingMatch,
      credentialHashes: [playing.credentialHashes[0], playing.credentialHashes[1]],
      room: {
        ...playing.room,
        seats: [
          {
            ...playing.room.seats[0],
            presence: {
              status: PRESENCE_STATUS.DISCONNECTED,
              reconnectDeadlineAt: epochMilliseconds(94_000),
            },
          },
          {
            ...playing.room.seats[1],
            presence: {
              status: PRESENCE_STATUS.DISCONNECTED,
              reconnectDeadlineAt: epochMilliseconds(94_000),
            },
          },
        ],
      },
    };
    repository.replace(roomId(ROOM_ID), bothDisconnected);

    const result = await executeResumeRoom(
      parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: JOINER_TOKEN }),
      dependencies(repository, 5_000),
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected resume success');
    expect(result.data.view.room.status).toBe('playing');
    expect(result.data.view.game?.match.status).toBe('playing');
    expect(repository.getById(roomId(ROOM_ID))).toBe(bothDisconnected);
  });

  test('rejects an expired waiting room and distinguishes an absent room only by public policy', async () => {
    const repository = new InMemoryRoomRepository();
    seedWaiting(repository);

    const expired = await executeResumeRoom(
      parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN }),
      dependencies(repository, 301_000),
    );
    const absent = await executeResumeRoom(
      parseResumeRoomRequest({
        roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c398499',
        seatToken: SEAT_TOKEN,
      }),
      dependencies(repository),
    );

    expect(expired).toMatchObject({
      error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE },
    });
    expect(absent).toMatchObject({ error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND } });
    expect(repository.getById(roomId(ROOM_ID))?.room.status).toBe('waiting');
  });
});
