import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomRequest, parseCreateRoomResponse } from '@repo/game-protocol/http';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import {
  type CreateRoomDependencies,
  executeCreateRoom,
} from '@/rooms/application/admission/create-room';
import { CreateRoomRateLimiter } from '@/rooms/application/admission/create-room-rate-limiter';
import { verifySeatToken } from '@/rooms/application/connections/seat-token';
import type { RoomRepository } from '@/rooms/application/room-repository';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import type { RoomCode, RoomId } from '@/rooms/domain/room-model';
import { roomId } from '@/rooms/domain/room-model';

const CLIENT_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843d';
const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const SEAT_INDEX = 0 as const;
const REQUEST_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c398440';
const SEAT_TOKEN = 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91';

const request = parseCreateRoomRequest({
  clientId: CLIENT_ID,
  operationId: '4ba1e7d4-c077-4b80-b198-9b1f04c182c8',
  profile: { characterId: 'navy-bob', variant: false },
});

function identity(
  overrides: Partial<CreateRoomDependencies['identity']> = {},
): CreateRoomDependencies['identity'] {
  return {
    createRoomCodeCandidate: () => '001204',
    createRoomId: () => ROOM_ID,
    createSeatToken: () => SEAT_TOKEN,
    ...overrides,
  };
}

function dependencies(
  repository: RoomRepository = new InMemoryRoomRepository(),
  serverIdentity: CreateRoomDependencies['identity'] = identity(),
  rateLimiter: CreateRoomRateLimiter = new CreateRoomRateLimiter(),
): CreateRoomDependencies {
  return {
    clock: { now: () => 1_000 },
    identity: serverIdentity,
    rateLimiter,
    commits: new RoomStateCommitter({
      repository: repository,
      clock: { now: () => 1_000 },
      publishRoomState: () => undefined,
    }),
  };
}

describe('executeCreateRoom', () => {
  test('rejects process room capacity without eviction and admits after removal', () => {
    const repository = new InMemoryRoomRepository(1);
    const first = executeCreateRoom({ request, ipAddress: '192.0.2.1' }, dependencies(repository));
    if (!first.ok) throw new Error('fixture create failed');
    const next = dependencies(
      repository,
      identity({
        createRoomId: () => '018f47f2-c2d8-7f4a-8bf4-3f559c39843f',
        createRoomCodeCandidate: () => '001205',
      }),
    );
    expect(executeCreateRoom({ request, ipAddress: '192.0.2.2' }, next)).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED },
    });
    expect(repository.counts()).toEqual({ rooms: 1, codes: 1 });
    expect(repository.getById(roomId(ROOM_ID))).toBeDefined();
    repository.remove(roomId(ROOM_ID));
    expect(executeCreateRoom({ request, ipAddress: '192.0.2.2' }, next).ok).toBeTrue();
  });

  test('atomically persists one waiting room and returns the creator token once', () => {
    const repository = new InMemoryRoomRepository();
    const result = executeCreateRoom({ request, ipAddress: '192.0.2.1' }, dependencies(repository));

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected create success');
    expect(
      parseCreateRoomResponse({
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
      seatIndex: SEAT_INDEX,
      seatToken: SEAT_TOKEN,
    });

    const stored = repository.getById(roomId(ROOM_ID));
    expect(stored?.match).toBeNull();
    expect(stored?.stateVersion).toBe(0);
    expect(stored?.presenceVersion).toBe(0);
    expect(stored && verifySeatToken(SEAT_TOKEN, stored.credentialHashes[0])).toBeTrue();
    expect(JSON.stringify(stored)).not.toContain(SEAT_TOKEN);
  });

  test('allows separate same-client creates with isolated credentials', async () => {
    const repository = new InMemoryRoomRepository();
    let sequence = 0;
    const deps = dependencies(
      repository,
      identity({
        createRoomId: () => `018f47f2-c2d8-7f4a-8bf4-3f559c39844${sequence++}`,
        createRoomCodeCandidate: () => `00120${sequence}`,
        createSeatToken: () => `d9428888-122b-4d34-8f6f-1f0f4f7f6b9${sequence}`,
      }),
    );
    const results = await Promise.all([
      Promise.resolve().then(() => executeCreateRoom({ request, ipAddress: '192.0.2.1' }, deps)),
      Promise.resolve().then(() =>
        executeCreateRoom(
          {
            request: {
              ...request,
              operationId: parseCreateRoomRequest({
                ...request,
                operationId: '888d7ad9-0311-42e8-a245-8e57c3046606',
              }).operationId,
            },
            ipAddress: '192.0.2.2',
          },
          deps,
        ),
      ),
    ]);
    expect(results.every((result) => result.ok)).toBeTrue();
    const [first, second] = results;
    if (!first?.ok || !second?.ok) throw new Error('expected both creates');
    expect(first.data.authority.roomId).not.toBe(second.data.authority.roomId);
    const secondRecord = repository.getById(roomId(second.data.authority.roomId));
    expect(
      secondRecord &&
        verifySeatToken(first.data.authority.seatToken, secondRecord.credentialHashes[0]),
    ).toBeFalse();
    expect(repository.counts()).toMatchObject({ rooms: 2, codes: 2 });
  });

  test('stops after 32 atomic room-code collisions without persisting or exposing a token', () => {
    let attempts = 0;
    let tokenCalls = 0;
    const repository: RoomRepository = {
      createExclusive: () => {
        attempts += 1;
        return { ok: false, reason: 'codeConflict' };
      },
      findRoomIdByCode: (_code: RoomCode) => undefined,
      getById: (_roomId: RoomId) => undefined,
      listMaintenanceCandidateRoomIds: () => [],
      remove: () => undefined,
      replace: () => false,
    };
    const serverIdentity = identity({
      createRoomCodeCandidate: () => String(attempts).padStart(6, '0'),
      createSeatToken: () => {
        tokenCalls += 1;
        return SEAT_TOKEN;
      },
    });

    const result = executeCreateRoom(
      { request, ipAddress: '192.0.2.1' },
      dependencies(repository, serverIdentity),
    );

    expect(result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.ROOM_CODE_EXHAUSTED, params: {} },
    });
    expect(attempts).toBe(32);
    expect(tokenCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain(SEAT_TOKEN);
  });

  test('rejects a rate-limited request before generating identity or mutating storage', () => {
    const limiter = new CreateRoomRateLimiter();
    for (let attempt: number = 0; attempt < 10; attempt += 1) {
      limiter.consume({
        ipAddress: '192.0.2.10',
        attemptedAt: 1_000,
      });
    }
    let identityCalls = 0;
    const repository = new InMemoryRoomRepository();
    const deps = dependencies(
      repository,
      identity({
        createRoomId: () => {
          identityCalls += 1;
          return ROOM_ID;
        },
      }),
      limiter,
    );

    const result = executeCreateRoom({ request, ipAddress: '192.0.2.10' }, deps);

    expect(result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: 60_000 } },
    });
    expect(identityCalls).toBe(0);
    expect(repository.counts().rooms).toBe(0);
  });
});
