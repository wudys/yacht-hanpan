import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { CLIENT_ERROR_CODE } from '../errors';
import { createServerClock } from '../server-clock';
import { createGameSession } from './game-session';
import {
  AUTHORITY,
  authority,
  ConnectionSocket,
  FakeSocket,
  finishedGame,
  game,
  presence,
  ReceiverSocket,
  REQUEST_ID,
  RESPONSE,
  ROLL,
  room,
  ROOM_ID,
  view,
  viewFromGame,
} from './game-session.test-fixtures';

describe('game session sync', () => {
  test('preserves the socket receiver during initial and explicit synchronization', async () => {
    const socket = new ReceiverSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    try {
      expect(await session.connect()).toEqual({ ok: true });
      expect(socket.syncCount).toBe(1);
      expect(session.getSnapshot().syncRevision).toBe(1);
      expect(await session.synchronize()).toEqual({ ok: true });
      expect(socket.syncCount).toBe(2);
      expect(session.getSnapshot().syncRevision).toBe(2);
      expect(session.getSnapshot().game).toEqual(game(1));
    } finally {
      session.dispose();
    }
  });

  test('applies a jump immediately and coalesces explicit full-sync confirmations', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    const observedSyncLifecycle: Array<{
      connection: string;
      syncStatus: string;
      syncRevision: number;
    }> = [];
    session.subscribe(() => {
      const { connection, syncStatus, syncRevision } = session.getSnapshot();
      observedSyncLifecycle.push({ connection, syncStatus, syncRevision });
    });

    expect(session.getSnapshot()).toMatchObject({
      room: null,
      syncStatus: 'idle',
      syncRevision: 0,
    });
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({
      room: {
        status: 'playing',
        seats: [
          { profile: { characterId: 'navy-bob', variant: false } },
          { profile: { characterId: 'blonde-buns', variant: false } },
        ],
      },
      syncStatus: 'idle',
      syncRevision: 1,
    });
    expect(observedSyncLifecycle).not.toContainEqual({
      connection: 'connected',
      syncStatus: 'idle',
      syncRevision: 0,
    });

    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (nextAcknowledge): void => {
      acknowledge = nextAcknowledge;
    };
    socket.syncVersion = 5;
    for (const listener of socket.listeners.roomUpdate) {
      listener({ type: 'state:committed', view: viewFromGame(game(5)) });
    }
    const external = session.synchronize();
    const coalescedExternal = session.synchronize();

    expect(socket.syncCount).toBe(2);
    expect(session.getSnapshot()).toMatchObject({
      syncStatus: 'synchronizing',
      syncRevision: 1,
      game: { stateVersion: 5 },
    });

    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(5), presence: presence(5) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    expect(await Promise.all([external, coalescedExternal])).toEqual([{ ok: true }, { ok: true }]);
    expect(session.getSnapshot()).toMatchObject({
      syncStatus: 'idle',
      syncRevision: 2,
      game: { stateVersion: 5 },
      presence: { presenceVersion: 5 },
    });
  });

  test('ignores an older full view without regressing authority or a newer clock sample', async () => {
    const socket = new FakeSocket();
    let now = 0;
    const clock = createServerClock(() => now);
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      clock,
    });
    await session.connect();
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (next) => {
      acknowledge = next;
    };
    now = 100;
    const pending = session.synchronize();
    for (const listener of socket.listeners.roomUpdate) {
      listener({ type: 'state:committed', view: viewFromGame(game(5), 2) });
    }
    now = 110;
    const newerSample = clock.beginSample();
    now = 120;
    clock.acceptSample(newerSample, 2000);
    const completed: unknown[] = [];
    session.subscribe(() => {
      const current = session.getSnapshot();
      if (current.syncStatus === 'idle') {
        completed.push({
          version: current.game?.stateVersion,
          revision: current.syncRevision,
          time: clock.now(),
        });
      }
    });
    now = 140;
    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(1), presence: presence(2) },
      meta: { requestId: REQUEST_ID, serverTime: 1500, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    expect(await pending).toEqual({ ok: true });
    expect(completed).toEqual([{ version: 5, revision: 2, time: 2025 }]);
    expect(Number(session.getSnapshot().presence?.presenceVersion)).toBe(2);
    session.dispose();
  });

  test('rejects coherent snapshots for another room before changing state or the clock', async () => {
    const socket = new FakeSocket();
    const clock = createServerClock(() => 0);
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      clock,
    });
    await session.connect();
    const foreignRoomId = '01890f47-e89b-7cc3-98c5-4c5da03f78ac';
    socket.syncResponder = (acknowledge) =>
      acknowledge({
        ok: true,
        data: {
          room: { ...room(), roomId: foreignRoomId },
          game: game(8),
          presence: { ...presence(8), roomId: foreignRoomId },
        },
        meta: {
          requestId: REQUEST_ID,
          serverTime: 9000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
    expect(await session.synchronize()).toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE', requestId: REQUEST_ID },
    });
    expect(session.getSnapshot()).toMatchObject({
      syncRevision: 1,
      game: { stateVersion: 1 },
      presence: { presenceVersion: 1 },
    });
    expect(clock.now()).toBe(1000);
    session.dispose();
  });

  test('publishes a waiting room and its clock sample together after authentication', async () => {
    const socket = new FakeSocket();
    let now = 10;
    const clock = createServerClock(() => now);
    socket.syncResponder = (acknowledge) => {
      now = 30;
      acknowledge({
        ok: true,
        data: {
          room: {
            status: 'waiting',
            roomId: ROOM_ID,
            roomCode: '123456',
            createdAt: 1,
            expiresAt: 301000,
            seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
          },
          game: null,
          presence: { roomId: ROOM_ID, presenceVersion: 1, seats: [{ status: 'connected' }] },
        },
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
    };
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      clock,
    });
    const completed: unknown[] = [];
    session.subscribe(() => {
      const current = session.getSnapshot();
      if (current.syncRevision > 0)
        completed.push({
          room: current.room?.status,
          game: current.game,
          presence: current.presence?.presenceVersion,
          time: clock.now(),
          status: current.syncStatus,
        });
    });
    expect(await session.connect()).toEqual({ ok: true });
    expect(completed).toEqual([
      { room: 'waiting', game: null, presence: 1, time: 1010, status: 'idle' },
    ]);
    session.dispose();
  });

  test('does not advance sync revision when full sync fails', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    socket.syncResponder = (acknowledge): void =>
      acknowledge({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, params: {} },
        meta: { requestId: REQUEST_ID, gameProtocolVersion: GAME_PROTOCOL_VERSION },
      });

    expect(await session.synchronize()).toMatchObject({ ok: false });
    expect(session.getSnapshot()).toMatchObject({
      syncStatus: 'idle',
      syncRevision: 1,
      error: { kind: 'server', error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE } },
    });
  });

  test('lets a reentrant subscriber cancel the sync before its late acknowledgement applies', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (nextAcknowledge): void => {
      acknowledge = nextAcknowledge;
    };
    let cancelled = false;
    session.subscribe(() => {
      if (!cancelled && session.getSnapshot().syncStatus === 'synchronizing') {
        cancelled = true;
        session.disconnect();
      }
    });

    const pending = session.synchronize();
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
    });
    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(8), presence: presence(8) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    await Bun.sleep(0);

    expect(socket.syncCount).toBe(2);
    expect(session.getSnapshot()).toMatchObject({
      connection: 'disconnected',
      syncStatus: 'idle',
      syncRevision: 1,
      game: { stateVersion: 1 },
    });
  });

  test('coalesces a synchronize call made reentrantly by a lifecycle subscriber', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (nextAcknowledge): void => {
      acknowledge = nextAcknowledge;
    };
    let reentrant: ReturnType<typeof session.synchronize> | undefined;
    session.subscribe(() => {
      if (reentrant === undefined && session.getSnapshot().syncStatus === 'synchronizing') {
        reentrant = session.synchronize();
      }
    });

    const requested = session.synchronize();
    expect(socket.syncCount).toBe(2);
    expect(reentrant).toBeDefined();
    if (reentrant === undefined) throw new Error('Expected a reentrant synchronization');
    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(5), presence: presence(5) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });

    expect(await Promise.all([requested, reentrant])).toEqual([{ ok: true }, { ok: true }]);
    expect(session.getSnapshot()).toMatchObject({ syncStatus: 'idle', syncRevision: 2 });
  });

  test('rejects a conflicting roll update without applying it and recovers through full sync', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    await session.connect();
    const baseline = session.getSnapshot().game;
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (next) => {
      acknowledge = next;
    };
    try {
      for (const listener of socket.listeners.roomUpdate) {
        listener({
          type: 'roll:committed',
          view: viewFromGame(game(2, true)),
          roll: { ...ROLL, outcome: { authoritativeValuesBySlot: [{ slot: 0, value: 6 }] } },
        });
      }

      expect(session.getSnapshot().game).toBe(baseline);
      expect(session.getSnapshot()).toMatchObject({
        presentation: { kind: 'settled' },
        syncStatus: 'synchronizing',
        error: { kind: 'protocol', code: 'INVALID_RESPONSE' },
      });
      expect(socket.syncCount).toBe(2);
      const recovery = session.synchronize();
      acknowledge?.({
        ok: true,
        data: { room: room(), game: game(2, true), presence: presence(2) },
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
      expect(await recovery).toEqual({ ok: true });
      expect(session.getSnapshot()).toMatchObject({
        game: { stateVersion: 2 },
        presentation: { kind: 'settled' },
        syncStatus: 'idle',
        syncRevision: 2,
        error: null,
      });
      expect(socket.syncCount).toBe(2);
    } finally {
      session.dispose();
    }
  });

  test('does not start malformed-update recovery after an error subscriber disconnects', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    let disconnected = false;
    session.subscribe(() => {
      if (!disconnected && session.getSnapshot().error?.kind === 'protocol') {
        disconnected = true;
        session.disconnect();
      }
    });

    for (const listener of socket.listeners.roomUpdate) listener({ malformed: true });
    await Bun.sleep(0);

    expect(socket.syncCount).toBe(1);
    expect(session.getSnapshot()).toMatchObject({
      connection: 'disconnected',
      syncStatus: 'idle',
      syncRevision: 1,
    });
  });

  test('cancels a full sync on a transport disconnect and ignores its late acknowledgement', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (nextAcknowledge): void => {
      acknowledge = nextAcknowledge;
    };

    const pending = session.synchronize();
    for (const listener of socket.listeners.disconnected) listener();
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
    });
    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(8), presence: presence(8) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    await Bun.sleep(0);

    expect(session.getSnapshot()).toMatchObject({
      connection: 'disconnected',
      syncStatus: 'idle',
      syncRevision: 1,
      game: { stateVersion: 1 },
    });
  });

  test('disposal keeps a late full-sync acknowledgement from changing the final snapshot', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 5_000, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (nextAcknowledge): void => {
      acknowledge = nextAcknowledge;
    };

    const pending = session.synchronize();
    session.dispose();
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
    });
    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(8), presence: presence(8) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    await Bun.sleep(0);

    expect(session.getSnapshot()).toMatchObject({
      connection: 'disposed',
      syncStatus: 'idle',
      syncRevision: 1,
      game: { stateVersion: 1 },
    });
  });

  test('applies consecutive and jumped complete views without supplemental sync', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => 'de305d54-75b4-431b-adb2-eb6b9e546010',
    });
    await session.connect();

    for (const listener of socket.listeners.roomUpdate) {
      listener({
        type: 'state:committed',
        view: viewFromGame(game(2)),
      });
    }
    expect(Number(session.getSnapshot().game?.stateVersion)).toBe(2);

    socket.syncVersion = 5;
    for (const listener of socket.listeners.roomUpdate) {
      listener({
        type: 'state:committed',
        view: viewFromGame(game(5)),
      });
    }
    await Bun.sleep(0);
    expect(socket.syncCount).toBe(1);
    expect(Number(session.getSnapshot().game?.stateVersion)).toBe(5);
  });

  test('accepts finished room metadata from the same live view without supplemental sync', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();

    for (const listener of socket.listeners.roomUpdate) {
      listener({ type: 'state:committed', view: viewFromGame(finishedGame(2)) });
    }
    await Bun.sleep(0);

    expect(socket.syncCount).toBe(1);
    expect(session.getSnapshot()).toMatchObject({
      room: { status: 'finished' },
      game: { stateVersion: 2, match: { status: 'finished' } },
    });
  });

  test.each([
    { gameVersion: 1, presenceVersion: 2, kind: 'roll' },
    { gameVersion: 2, presenceVersion: 2, kind: 'settled' },
    { gameVersion: 2, presenceVersion: 1, kind: 'settled' },
    { gameVersion: 3, presenceVersion: 2, kind: 'settled' },
  ] as const)(
    'full sync $gameVersion/$presenceVersion confirms authority with $kind presentation',
    async ({ gameVersion, presenceVersion, kind }) => {
      const socket = new FakeSocket();
      const clock = createServerClock(() => 0);
      const session = createGameSession({
        socketUrl: 'https://game.example.test',
        authority: AUTHORITY,
        contract: createCompatibilityContract('release-1'),
        socketFactory: { create: () => socket },
        clock,
      });
      try {
        await session.connect();
        for (const listener of socket.listeners.roomUpdate)
          listener({ type: 'roll:committed', view: viewFromGame(game(2, true), 2), roll: ROLL });
        const fresh = session.getSnapshot();
        socket.syncResponder = (acknowledge) =>
          acknowledge({
            ok: true,
            data: viewFromGame(game(gameVersion, gameVersion >= 2), presenceVersion),
            meta: {
              requestId: REQUEST_ID,
              serverTime: 2000,
              gameProtocolVersion: GAME_PROTOCOL_VERSION,
            },
          });
        expect(await session.synchronize()).toEqual({ ok: true });
        const restored = session.getSnapshot();
        expect(restored.presentation?.kind).toBe(kind);
        expect(restored.syncRevision).toBe(2);
        expect(Number(restored.game?.stateVersion)).toBe(Math.max(2, gameVersion));
        expect(Number(restored.presence?.presenceVersion)).toBe(2);
        expect(clock.now()).toBe(2000);
        if (kind === 'roll') expect(restored.presentation).toBe(fresh.presentation);
      } finally {
        session.dispose();
      }
    },
  );

  test('rejects crossed full-sync counters before confirming recovery or accepting its clock', async () => {
    const socket = new FakeSocket();
    const clock = createServerClock(() => 0);
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      clock,
    });
    try {
      await session.connect();
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'roll:committed', view: viewFromGame(game(2, true), 2), roll: ROLL });
      const fresh = session.getSnapshot();
      socket.syncResponder = (acknowledge) =>
        acknowledge({
          ok: true,
          data: viewFromGame(game(1), 3),
          meta: {
            requestId: REQUEST_ID,
            serverTime: 9000,
            gameProtocolVersion: GAME_PROTOCOL_VERSION,
          },
        });
      expect(await session.synchronize()).toMatchObject({
        ok: false,
        error: { code: 'INVALID_RESPONSE' },
      });
      expect(session.getSnapshot()).toMatchObject({
        syncRevision: 1,
        game: { stateVersion: 2 },
        presence: { presenceVersion: 2 },
      });
      expect(session.getSnapshot().presentation).toBe(fresh.presentation);
      expect(session.getSnapshot().game).toBe(fresh.game);
      expect(clock.now()).toBe(1000);
    } finally {
      session.dispose();
    }
  });

  test('a start view received during initial waiting sync needs no metadata sync afterward', async () => {
    const socket = new FakeSocket();
    let acknowledge!: (value: unknown) => void;
    socket.syncResponder = (reply) => {
      acknowledge = reply;
    };
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    try {
      const connected = session.connect();
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'state:committed', view: viewFromGame(game(1), 2) });
      acknowledge({
        ok: true,
        data: {
          room: {
            status: 'waiting',
            roomId: ROOM_ID,
            roomCode: '123456',
            createdAt: 1,
            expiresAt: 301000,
            seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
          },
          game: null,
          presence: { roomId: ROOM_ID, presenceVersion: 1, seats: [{ status: 'connected' }] },
        },
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
      expect(await connected).toEqual({ ok: true });
      expect(session.getSnapshot()).toMatchObject({
        room: {
          status: 'playing',
          seats: [
            { profile: { characterId: 'navy-bob' } },
            { profile: { characterId: 'blonde-buns' } },
          ],
        },
        game: { stateVersion: 1 },
        presence: { presenceVersion: 2 },
        syncRevision: 1,
      });
      expect(socket.syncCount).toBe(1);
    } finally {
      session.dispose();
    }
  });

  test('a finish view survives an older in-flight playing sync without a successor request', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    try {
      await session.connect();
      let acknowledge!: (value: unknown) => void;
      socket.syncResponder = (reply) => {
        acknowledge = reply;
      };
      const pending = session.synchronize();
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'state:committed', view: viewFromGame(finishedGame(2), 2) });
      const finished = session.getSnapshot();
      acknowledge({
        ok: true,
        data: viewFromGame(game(1)),
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
      expect(await pending).toEqual({ ok: true });
      expect(session.getSnapshot()).toMatchObject({
        room: { status: 'finished' },
        game: { stateVersion: 2, match: { status: 'finished' } },
        presence: { presenceVersion: 2 },
        syncRevision: 2,
      });
      expect(session.getSnapshot().game).toBe(finished.game);
      expect(session.getSnapshot().room).toBe(finished.room);
      expect(socket.syncCount).toBe(2);
    } finally {
      session.dispose();
    }
  });

  test('rejects unsafe timestamp metadata before confirming a full sync or accepting its clock', async () => {
    const socket = new ConnectionSocket();
    const clock = createServerClock(() => 0);
    let serverTime = Number.MAX_SAFE_INTEGER + 1;
    socket.emitSync = (acknowledge) => {
      socket.syncCount += 1;
      acknowledge({ ok: true, data: view, meta: { ...RESPONSE.meta, serverTime } });
    };
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      clock,
    });
    try {
      expect(await session.connect()).toEqual({
        ok: false,
        error: { kind: 'protocol', code: CLIENT_ERROR_CODE.INVALID_RESPONSE },
      });
      expect(session.getSnapshot()).toMatchObject({
        room: null,
        syncStatus: 'idle',
        syncRevision: 0,
        error: { kind: 'protocol', code: CLIENT_ERROR_CODE.INVALID_RESPONSE },
      });
      expect(clock.now()).toBeNull();
      expect(socket.syncCount).toBe(1);

      serverTime = Number.MAX_SAFE_INTEGER;
      expect(await session.synchronize()).toEqual({ ok: true });
      expect(session.getSnapshot()).toMatchObject({
        room: view.room,
        syncRevision: 1,
        error: null,
      });
      expect(clock.now()).toBe(Number.MAX_SAFE_INTEGER);
    } finally {
      session.dispose();
    }
  });
});
