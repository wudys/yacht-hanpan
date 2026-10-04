import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomRequest } from '@repo/game-protocol/http';
import { parseSocketAuth } from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { executeCreateRoom } from '@/rooms/admission/create-room';
import { CreateRoomRateLimiter } from '@/rooms/admission/create-room-rate-limit';
import { RoomStateCommitter, type RoomStatePublication } from '@/rooms/commit';
import { executeConnectSeat } from '@/rooms/connections/connect-seat';
import { ConnectionRegistry } from '@/rooms/connections/connection-registry';
import { roomId } from '@/rooms/domain/room-model';
import { InMemoryRoomRepository } from '@/rooms/repository';
import { InMemoryRoomTaskQueue } from '@/rooms/scheduling/room-task-queue';

const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const SEAT_INDEX = 0 as const;
const SEAT_TOKEN = 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91';
const contract = createCompatibilityContract('test-release');

function fixture() {
  const repository = new InMemoryRoomRepository();
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
  if (!created.ok) throw new Error('fixture create failed');
  const connections = new ConnectionRegistry();
  const published: RoomStatePublication[] = [];
  return {
    connections,
    published,
    queue: new InMemoryRoomTaskQueue(),
    repository,
    commits: new RoomStateCommitter({
      repository: repository,
      clock: { now: () => 0 },
      publishRoomState: (publication) => {
        expect(connections.get(roomId(ROOM_ID), 0)).toBeDefined();
        published.push(publication);
      },
    }),
  };
}

describe('executeConnectSeat', () => {
  test('allows the same execution to recover while its old transport is still registered', async () => {
    const state = fixture();
    const auth = parseSocketAuth({
      executionId: crypto.randomUUID(),
      connectionIntent: 'enter',
      roomId: ROOM_ID,
      seatToken: SEAT_TOKEN,
      contract,
    });
    await executeConnectSeat(
      { auth, connectedAt: 2_000, connectionId: 'old-transport' },
      { ...state, expectedContract: contract },
    );
    const result = await executeConnectSeat(
      {
        auth: { ...auth, connectionIntent: 'reconnect' },
        connectedAt: 3_000,
        connectionId: 'new-transport',
      },
      { ...state, expectedContract: contract },
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        previousConnectionId: 'old-transport',
        replacedExecution: false,
      },
    });
    expect(state.connections.unbind(roomId(ROOM_ID), 0, 'old-transport')).toBeFalse();
    expect(state.connections.get(roomId(ROOM_ID), 0)?.connectionId).toBe('new-transport');
    expect(state.published).toHaveLength(1);
  });

  test('allows automatic recovery when no competing execution is active', async () => {
    const state = fixture();
    const auth = parseSocketAuth({
      executionId: crypto.randomUUID(),
      connectionIntent: 'reconnect',
      roomId: ROOM_ID,
      seatToken: SEAT_TOKEN,
      contract,
    });
    expect(
      await executeConnectSeat(
        { auth, connectedAt: 2_000, connectionId: 'recovered' },
        { ...state, expectedContract: contract },
      ),
    ).toMatchObject({ ok: true, data: { previousConnectionId: null, replacedExecution: false } });
  });

  test('rejects an old execution reconnect without changing the active seat', async () => {
    const state = fixture();
    const auth = parseSocketAuth({
      executionId: crypto.randomUUID(),
      connectionIntent: 'enter',
      roomId: ROOM_ID,
      seatToken: SEAT_TOKEN,
      contract,
    });
    const first = {
      ...auth,
      executionId: '550e8400-e29b-41d4-a716-446655440000',
      connectionIntent: 'enter' as const,
    };
    const second = { ...first, executionId: '550e8400-e29b-41d4-a716-446655440001' };
    await executeConnectSeat(
      { auth: first, connectedAt: 2_000, connectionId: 'socket-a' },
      { ...state, expectedContract: contract },
    );
    expect(
      await executeConnectSeat(
        { auth: second, connectedAt: 3_000, connectionId: 'socket-b' },
        { ...state, expectedContract: contract },
      ),
    ).toMatchObject({ ok: true, data: { replacedExecution: true } });
    const before = state.repository.getById(roomId(ROOM_ID));
    const result = await executeConnectSeat(
      {
        auth: { ...first, connectionIntent: 'reconnect' },
        connectedAt: 4_000,
        connectionId: 'socket-a-return',
      },
      { ...state, expectedContract: contract },
    );
    expect(result).toEqual({ ok: false, error: { code: 'SESSION_REPLACED', params: {} } });
    expect(state.repository.getById(roomId(ROOM_ID))).toBe(before);
    expect(state.connections.get(roomId(ROOM_ID), 0)?.connectionId).toBe('socket-b');
  });

  test('authenticates, connects presence, and returns no raw credential', async () => {
    const state = fixture();
    const result = await executeConnectSeat(
      {
        auth: parseSocketAuth({
          executionId: crypto.randomUUID(),
          connectionIntent: 'enter',
          roomId: ROOM_ID,
          seatToken: SEAT_TOKEN,
          contract,
        }),
        connectedAt: 2_000,
        connectionId: 'socket-a',
      },
      { ...state, expectedContract: contract },
    );

    expect(result.ok).toBeTrue();
    if (!result.ok) throw new Error('expected connect success');
    expect(result.data).toMatchObject({
      roomId: ROOM_ID,
      seatIndex: SEAT_INDEX,
      previousConnectionId: null,
    });
    expect(state.published).toHaveLength(1);
    expect(state.published[0]?.update.view.presence).toMatchObject({
      presenceVersion: 1,
      seats: [{ status: 'connected' }],
    });
    expect(state.repository.getById(roomId(ROOM_ID))?.presenceVersion).toBe(1);
    expect(state.connections.get(roomId(ROOM_ID), result.data.seatIndex)?.connectionId).toBe(
      'socket-a',
    );
    expect(JSON.stringify(result)).not.toContain(SEAT_TOKEN);
  });

  test('replaces the active socket without changing public presence twice', async () => {
    const state = fixture();
    const auth = parseSocketAuth({
      executionId: crypto.randomUUID(),
      connectionIntent: 'enter',
      roomId: ROOM_ID,
      seatToken: SEAT_TOKEN,
      contract,
    });
    await executeConnectSeat(
      { auth, connectedAt: 2_000, connectionId: 'socket-a' },
      { ...state, expectedContract: contract },
    );
    const replaced = await executeConnectSeat(
      { auth, connectedAt: 3_000, connectionId: 'socket-b' },
      { ...state, expectedContract: contract },
    );

    expect(replaced.ok).toBeTrue();
    if (!replaced.ok) throw new Error('expected replacement success');
    expect(replaced.data.previousConnectionId).toBe('socket-a');
    expect(state.published).toHaveLength(1);
    expect(state.repository.getById(roomId(ROOM_ID))?.presenceVersion).toBe(1);
  });

  test('rejects release mismatch before credential or presence mutation', async () => {
    const state = fixture();
    const result = await executeConnectSeat(
      {
        auth: parseSocketAuth({
          executionId: crypto.randomUUID(),
          connectionIntent: 'enter',
          roomId: ROOM_ID,
          seatToken: SEAT_TOKEN,
          contract: { ...contract, releaseId: 'stale-release' },
        }),
        connectedAt: 2_000,
        connectionId: 'socket-a',
      },
      { ...state, expectedContract: contract },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH, params: {} },
    });
    expect(state.repository.getById(roomId(ROOM_ID))?.presenceVersion).toBe(0);
    expect(state.connections.get(roomId(ROOM_ID), 0)).toBeUndefined();
    expect(state.connections.get(roomId(ROOM_ID), 1)).toBeUndefined();
  });

  test('does not replace an active connection when the waiting deadline has been reached', async () => {
    const state = fixture();
    const auth = parseSocketAuth({
      executionId: crypto.randomUUID(),
      connectionIntent: 'enter',
      roomId: ROOM_ID,
      seatToken: SEAT_TOKEN,
      contract,
    });
    await executeConnectSeat(
      { auth, connectedAt: 2_000, connectionId: 'active' },
      { ...state, expectedContract: contract },
    );
    const before = state.repository.getById(roomId(ROOM_ID));
    const result = await executeConnectSeat(
      {
        auth: { ...auth, executionId: crypto.randomUUID() },
        connectedAt: 301_000,
        connectionId: 'late',
      },
      { ...state, expectedContract: contract },
    );
    expect(result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, params: {} },
    });
    expect(state.repository.getById(roomId(ROOM_ID))).toBe(before);
    expect(state.connections.get(roomId(ROOM_ID), 0)?.connectionId).toBe('active');
  });

  test('collapses wrong authority without revealing room membership', async () => {
    const state = fixture();
    const result = await executeConnectSeat(
      {
        auth: parseSocketAuth({
          executionId: crypto.randomUUID(),
          connectionIntent: 'enter',
          roomId: ROOM_ID,
          seatToken: '9207e571-a39a-49d5-a75f-a08d5e52cce8',
          contract,
        }),
        connectedAt: 2_000,
        connectionId: 'socket-a',
      },
      { ...state, expectedContract: contract },
    );

    expect(result).toEqual({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} },
    });
  });
});
