import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  parseCreateRoomRequest,
  parseJoinRoomRequest,
  parseJoinRoomResponse,
} from '@repo/game-protocol/http';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { executeCreateRoom } from '@/rooms/application/admission/create-room';
import { CreateRoomRateLimiter } from '@/rooms/application/admission/create-room-rate-limiter';
import {
  executeJoinRoom,
  type JoinRoomDependencies,
} from '@/rooms/application/admission/join-room';
import { verifySeatToken } from '@/rooms/application/connections/seat-token';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import { InMemoryRoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { roomId } from '@/rooms/domain/room-model';

const CREATOR_CLIENT_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843d';
const JOINER_CLIENT_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398442';
const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const JOINER_SEAT_INDEX = 1 as const;
const TURN_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398441';
const REQUEST_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398443';
const CREATOR_TOKEN = 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91';
const JOINER_TOKEN = '9207e571-a39a-49d5-a75f-a08d5e52cce8';

function seedWaiting(repository: InMemoryRoomRepository): void {
  const created = executeCreateRoom(
    {
      request: parseCreateRoomRequest({
        clientId: CREATOR_CLIENT_ID,
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
        createSeatToken: () => CREATOR_TOKEN,
      },
      rateLimiter: new CreateRoomRateLimiter(),
      commits: new RoomStateCommitter({
        repository: repository,
        clock: { now: () => 1_000 },
        publishRoomState: () => undefined,
      }),
    },
  );
  if (!created.ok) throw new Error('fixture create failed');
}

function joinIdentity(
  tokenFactory: () => string = () => JOINER_TOKEN,
): JoinRoomDependencies['identity'] {
  return {
    createSeatToken: tokenFactory,
    createTurnId: () => TURN_ID,
  };
}

function joinDependencies(
  repository: InMemoryRoomRepository,
  now: number = 2_000,
  serverIdentity: JoinRoomDependencies['identity'] = joinIdentity(),
): JoinRoomDependencies {
  return {
    clock: { now: () => now },
    identity: serverIdentity,
    queue: new InMemoryRoomTaskQueue(),
    repository,
    commits: new RoomStateCommitter({
      repository: repository,
      clock: { now: () => now },
      publishRoomState: () => undefined,
    }),
  };
}

function joinRequest(characterId: 'navy-bob' | 'blonde-buns' = 'navy-bob') {
  return parseJoinRoomRequest({
    clientId: JOINER_CLIENT_ID,
    operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
    roomCode: '001204',
    profile: { characterId, variant: false },
  });
}

describe('executeJoinRoom', () => {
  test('atomically joins, creates the initial match, and returns only joiner authority', async () => {
    const repository = new InMemoryRoomRepository();
    seedWaiting(repository);

    const result = await executeJoinRoom(joinRequest(), joinDependencies(repository));

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected join success');
    expect(
      parseJoinRoomResponse({
        ...result,
        meta: {
          requestId: REQUEST_ID,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
          serverTime: 1000,
        },
      }),
    ).toBeDefined();
    expect(result.data.authority).toEqual({
      roomId: ROOM_ID,
      seatIndex: JOINER_SEAT_INDEX,
      seatToken: JOINER_TOKEN,
    });
    if (result.data.view.room.status !== 'playing') throw new Error('expected playing room');
    expect(result.data.view.room.seats[1].profile.variant).toBe(false);
    expect(Number(result.data.view.presence.presenceVersion)).toBe(1);
    expect(JSON.stringify(result)).not.toContain(CREATOR_TOKEN);

    const stored = repository.getById(roomId(ROOM_ID));
    expect(stored?.room.status).toBe('playing');
    expect(stored?.match?.status).toBe('playing');
    expect(stored?.stateVersion).toBe(1);
    expect(stored?.presenceVersion).toBe(1);
    expect(stored?.credentialHashes).toHaveLength(2);
    if (stored?.match?.status !== 'playing' || stored.credentialHashes.length !== 2) {
      throw new Error('expected persisted playing record');
    }
    expect(verifySeatToken(JOINER_TOKEN, stored.credentialHashes[1])).toBeTrue();
    expect(String(stored.match.currentTurn.id)).toBe(TURN_ID);
  });

  test('starts the initial turn at receipt time even when the room queue delays admission', async () => {
    const repository = new InMemoryRoomRepository();
    seedWaiting(repository);
    let now = 2_000;
    const clock = { now: () => now };
    const queue = new InMemoryRoomTaskQueue({ clock });
    const publicationTimes: number[] = [];
    const dependencies: JoinRoomDependencies = {
      clock,
      identity: joinIdentity(),
      queue,
      repository,
      commits: new RoomStateCommitter({
        repository,
        clock,
        publishRoomState: () => {
          publicationTimes.push(clock.now());
        },
      }),
    };
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const blocker = queue.runInternal(roomId(ROOM_ID), () => {
      entered.resolve();
      return gate.promise;
    });
    await entered.promise;
    const joining = executeJoinRoom(joinRequest(), dependencies);

    try {
      expect(queue.pendingRequestCount).toBe(1);
      expect(repository.getById(roomId(ROOM_ID))?.room.status).toBe('waiting');
      expect(publicationTimes).toEqual([]);
      now = 12_000;
      gate.resolve();
      const result = await joining;
      if (!result.ok) throw new Error('expected join success');

      expect(publicationTimes).toEqual([12_000]);
      expect(result.data.view.game).toMatchObject({
        match: {
          status: 'playing',
          currentTurn: { startedAt: 2_000, deadlineAt: 92_000 },
        },
      });
      expect(repository.getById(roomId(ROOM_ID))).toMatchObject({
        room: { status: 'playing' },
        match: {
          status: 'playing',
          currentTurn: { startedAt: 2_000, deadlineAt: 92_000 },
        },
      });
    } finally {
      gate.resolve();
      await Promise.allSettled([blocker, joining]);
      queue.close();
    }
  });

  test('serializes simultaneous joins so exactly one creates the match', async () => {
    const repository = new InMemoryRoomRepository();
    seedWaiting(repository);
    const deps = joinDependencies(repository);

    const results = await Promise.all([
      executeJoinRoom(joinRequest('navy-bob'), deps),
      executeJoinRoom(joinRequest('blonde-buns'), deps),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_JOINABLE },
    });
    const stored = repository.getById(roomId(ROOM_ID));
    expect(stored?.credentialHashes).toHaveLength(2);
  });

  test('rejects a join before creation without allocating authority or publishing', async () => {
    const repository = new InMemoryRoomRepository();
    seedWaiting(repository);
    const before = repository.getById(roomId(ROOM_ID));
    let tokenCalls = 0;
    let turnCalls = 0;
    let publications = 0;
    const dependencies = joinDependencies(repository, 999, {
      createSeatToken: () => {
        tokenCalls += 1;
        return JOINER_TOKEN;
      },
      createTurnId: () => {
        turnCalls += 1;
        return TURN_ID;
      },
    });
    const result = await executeJoinRoom(joinRequest(), {
      ...dependencies,
      commits: new RoomStateCommitter({
        repository,
        clock: dependencies.clock,
        publishRoomState: () => {
          publications += 1;
        },
      }),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
    });
    expect(tokenCalls).toBe(0);
    expect(turnCalls).toBe(0);
    expect(publications).toBe(0);
    expect(repository.getById(roomId(ROOM_ID))).toBe(before);
  });

  test('rejects the exact waiting expiry boundary without token or record mutation', async () => {
    const repository = new InMemoryRoomRepository();
    seedWaiting(repository);
    let tokenCalls = 0;
    const deps = joinDependencies(
      repository,
      301_000,
      joinIdentity(() => {
        tokenCalls += 1;
        return JOINER_TOKEN;
      }),
    );

    const result = await executeJoinRoom(joinRequest(), deps);

    expect(result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_JOINABLE, params: {} },
    });
    expect(tokenCalls).toBe(0);
    const stored = repository.getById(roomId(ROOM_ID));
    expect(stored?.room.status).toBe('waiting');
    expect(stored?.credentialHashes).toHaveLength(1);
  });
});
