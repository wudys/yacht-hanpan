import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  parseCancelRoomRequest,
  parseCreateRoomRequest,
  parseJoinRoomRequest,
} from '@repo/game-protocol/http';
import { describe, expect, test } from 'bun:test';

import { executeCancelRoom } from '@/rooms/application/admission/cancel-room';
import { executeCreateRoom } from '@/rooms/application/admission/create-room';
import { CreateRoomRateLimiter } from '@/rooms/application/admission/create-room-rate-limiter';
import { executeJoinRoom } from '@/rooms/application/admission/join-room';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import { InMemoryRoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { roomId } from '@/rooms/domain/room-model';
import type { ServerIdentity } from '@/runtime/server-identity';

const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const CREATOR_TOKEN = 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91';
const JOINER_TOKEN = '9207e571-a39a-49d5-a75f-a08d5e52cce8';

function identity(): ServerIdentity {
  return {
    createRequestId: () => '018f47f2-c2d8-7f4a-8bf4-3f559c398440',
    createRoomCodeCandidate: () => '001204',
    createRoomId: () => ROOM_ID,
    createSeatToken: () => CREATOR_TOKEN,
    createTurnId: () => '018f47f2-c2d8-7f4a-8bf4-3f559c398441',
  };
}

function fixture() {
  const repository = new InMemoryRoomRepository();
  const queue = new InMemoryRoomTaskQueue();
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
      identity: identity(),
      rateLimiter: new CreateRoomRateLimiter(),
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 1_000 },
        publishRoomState: () => undefined,
      }),
    },
  );
  if (!created.ok) throw new Error('fixture create failed');
  return {
    repository,
    queue,
    commits: new RoomStateCommitter({
      repository: repository,
      clock: { now: () => 0 },
      publishRoomState: () => undefined,
    }),
  };
}

function request(token: string = CREATOR_TOKEN) {
  return parseCancelRoomRequest({ roomId: ROOM_ID, seatToken: token });
}

describe('executeCancelRoom', () => {
  test('removes a waiting room and its indexes for the creator', async () => {
    const { repository, queue } = fixture();

    const result = await executeCancelRoom(request(), {
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 0 },
        publishRoomState: () => undefined,
      }),
    });

    expect(result).toEqual({ ok: true, data: { cancelled: true } });
    expect(repository.getById(roomId(ROOM_ID))).toBeUndefined();
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
  });

  test('is idempotent after the room was already removed', async () => {
    const { repository, queue } = fixture();
    await executeCancelRoom(request(), {
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 0 },
        publishRoomState: () => undefined,
      }),
    });

    expect(
      await executeCancelRoom(request(), {
        queue,
        repository,
        commits: new RoomStateCommitter({
          repository: repository,
          clock: { now: () => 0 },
          publishRoomState: () => undefined,
        }),
      }),
    ).toEqual({
      ok: true,
      data: { cancelled: true },
    });
  });

  test('rejects a non-creator token without removing the waiting room', async () => {
    const { repository, queue } = fixture();

    const result = await executeCancelRoom(request(JOINER_TOKEN), {
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 0 },
        publishRoomState: () => undefined,
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} },
    });
    expect(repository.getById(roomId(ROOM_ID))).toBeDefined();
  });

  test('returns ROOM_ALREADY_MATCHED when join committed first', async () => {
    const { repository, queue } = fixture();
    await executeJoinRoom(
      parseJoinRoomRequest({
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398442',
        operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
        roomCode: '001204',
        profile: { characterId: 'blonde-buns', variant: false },
      }),
      {
        clock: { now: () => 2_000 },
        identity: { ...identity(), createSeatToken: () => JOINER_TOKEN },
        queue,
        repository,
        commits: new RoomStateCommitter({
          repository: repository,
          clock: { now: () => 2_000 },
          publishRoomState: () => undefined,
        }),
      },
    );

    const result = await executeCancelRoom(request(), {
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 0 },
        publishRoomState: () => undefined,
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.ROOM_ALREADY_MATCHED, params: {} },
    });
    expect(repository.getById(roomId(ROOM_ID))?.room.status).toBe('playing');
  });

  test('does not reveal a matched room to an invalid token', async () => {
    const { repository, queue } = fixture();
    await executeJoinRoom(
      parseJoinRoomRequest({
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c398442',
        operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
        roomCode: '001204',
        profile: { characterId: 'blonde-buns', variant: false },
      }),
      {
        clock: { now: () => 2_000 },
        identity: { ...identity(), createSeatToken: () => JOINER_TOKEN },
        queue,
        repository,
        commits: new RoomStateCommitter({
          repository: repository,
          clock: { now: () => 2_000 },
          publishRoomState: () => undefined,
        }),
      },
    );

    expect(
      await executeCancelRoom(request(JOINER_TOKEN), {
        queue,
        repository,
        commits: new RoomStateCommitter({
          repository: repository,
          clock: { now: () => 0 },
          publishRoomState: () => undefined,
        }),
      }),
    ).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} },
    });
  });
});
