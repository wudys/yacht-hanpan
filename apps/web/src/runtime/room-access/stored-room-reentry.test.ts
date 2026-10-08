import type { GameClient, GameSession, GameSessionSnapshot } from '@repo/game-client-sdk';
import { CLIENT_ERROR_CODE, createTransportError } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import type { GameSnapshot, PresenceSnapshot, PublicRoom } from '@repo/game-protocol/state';
import { parsePublicRoom } from '@repo/game-protocol/state';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createServerReadiness, type ServerReadiness } from '@/runtime/network/server-readiness';
import { createStoredRoomReentry } from '@/runtime/room-access/stored-room-reentry';
import { createGameSessionHolder } from '@/runtime/session/game-session-holder';
import type {
  RecentRoom,
  SessionCredentialStore,
} from '@/runtime/session/session-credential-store';

const RECENT_ROOM = {
  roomId: '019cebf0-79b8-7a22-8000-000000000001',
  seatToken: '019cebf0-79b8-4a22-8000-000000000002',
} as RecentRoom;

const WAITING_ROOM = parsePublicRoom({
  roomId: RECENT_ROOM.roomId,
  roomCode: '001234',
  status: 'waiting',
  createdAt: 1_000,
  expiresAt: 61_000,
  seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
});
if (WAITING_ROOM.status !== 'waiting') throw new Error('Expected waiting fixture');

const PLAYING_ROOM = {
  ...WAITING_ROOM,
  status: 'playing',
  startedAt: 2_000,
  seats: [WAITING_ROOM.seats[0], { profile: { characterId: 'blonde-buns', variant: false } }],
} as unknown as Extract<PublicRoom, { status: 'playing' }>;

const PRESENCE = {
  roomId: RECENT_ROOM.roomId,
  presenceVersion: 1,
  seats: [{ seatIndex: 0, status: 'connected', reconnectDeadlineAt: null }],
} as unknown as PresenceSnapshot;

const PLAYING_GAME = {
  stateVersion: 1,
  match: { status: 'playing' },
} as GameSnapshot;

afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

describe('Lobby reentry', () => {
  test('does not start readiness after a checking observer disposes restore', async () => {
    const session = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const readiness = readyReadiness();
    const client = createClient(session.value);
    const reentry = createStoredRoomReentry({
      client,
      readiness,
      sessions: holder,
      sessionCredentialStore: createStore(RECENT_ROOM),
    });
    const attempts = vi.fn();
    const notifications = vi.fn();
    reentry.subscribeAttempt(attempts);
    reentry.subscribe(() => {
      notifications();
      if (reentry.getSnapshot().status === 'checking') reentry.dispose();
    });

    reentry.check();
    await flushPromises();

    expect(readiness.wait).not.toHaveBeenCalled();
    expect(client.resumeRoom).not.toHaveBeenCalled();
    expect(session.value.connect).not.toHaveBeenCalled();
    expect(notifications).toHaveBeenCalledOnce();
    expect(attempts.mock.calls).toEqual([
      [{ phase: 'started' }],
      [{ phase: 'finished', outcome: 'cancelled', durationMs: expect.any(Number) }],
    ]);
    holder.dispose();
  });

  test.each(['clear', 'replace', 'dispose'] as const)(
    'does not connect or clean credentials after an installation observer wins with %s',
    async (action) => {
      const session = createSessionFixture();
      const replacement = createSessionFixture();
      const createSession = vi
        .fn()
        .mockReturnValueOnce(session.value)
        .mockReturnValueOnce(replacement.value);
      const holder = createGameSessionHolder({ createSession });
      const sessionCredentialStore = createStore(RECENT_ROOM);
      const reentry = createStoredRoomReentry({
        client: createClient(session.value),
        readiness: readyReadiness(),
        sessions: holder,
        sessionCredentialStore,
      });
      let changed = false;
      holder.subscribe(() => {
        if (changed || holder.getSnapshot().authority === null) return;
        changed = true;
        expect(holder.getSnapshot().room).toBe(WAITING_ROOM);
        if (action === 'clear') holder.clear();
        else if (action === 'dispose') reentry.dispose();
        else holder.installAuthority({ ...RECENT_ROOM, seatIndex: 1 });
      });

      reentry.check();
      await flushPromises();
      expect(session.value.connect).not.toHaveBeenCalled();
      expect(replacement.value.connect).not.toHaveBeenCalled();
      expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
      reentry.dispose();
      holder.dispose();
    },
  );

  test.each(['connecting', 'synchronizing'] as const)(
    'does not start stale transport work after a %s publication observer stops restore',
    async (phase) => {
      const session = createSessionFixture();
      const holder = createGameSessionHolder({ createSession: () => session.value });
      const reentry = createStoredRoomReentry({
        client: createClient(session.value),
        readiness: readyReadiness(),
        sessions: holder,
        sessionCredentialStore: createStore(RECENT_ROOM),
      });
      reentry.subscribe(() => {
        if (reentry.getSnapshot().status === phase) reentry.dispose();
      });
      reentry.check();
      await flushPromises();
      if (phase === 'connecting') expect(session.value.connect).not.toHaveBeenCalled();
      else {
        session.publish({ connection: 'connected', presence: PRESENCE });
        expect(session.value.synchronize).not.toHaveBeenCalled();
      }
      holder.dispose();
    },
  );

  test.each(['replacement', 'Game'] as const)(
    'does not clear current %s when confirming an old restore failure',
    async (current) => {
      const session = createSessionFixture();
      const sessionCredentialStore = createStore(RECENT_ROOM);
      const holder = createGameSessionHolder({ createSession: () => session.value });
      const reentry = createStoredRoomReentry({
        client: createClient(session.value, {
          ok: false,
          error: { kind: 'server', error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: {} } },
        }),
        readiness: readyReadiness(),
        sessions: holder,
        sessionCredentialStore,
      });
      reentry.check();
      await flushPromises();
      const installed = {
        ...RECENT_ROOM,
        seatIndex: 0 as const,
        ...(current === 'replacement'
          ? { roomId: '019cebf0-79b8-7a22-8000-000000000003' as typeof RECENT_ROOM.roomId }
          : {}),
      };
      holder.installAuthority(installed);
      if (current === 'Game') session.publish({ game: PLAYING_GAME });
      const clear = vi.spyOn(holder, 'clear');
      reentry.confirmPermanentFailure();
      expect(clear).not.toHaveBeenCalled();
      expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
      expect(holder.getSnapshot().authority).toEqual(installed);
      reentry.dispose();
      holder.dispose();
    },
  );
  test.each(['Game', 'storage observer Game'] as const)(
    'does not clear a later %s when confirming a failed pending restore',
    async (arrival) => {
      const session = createSessionFixture();
      const sessionCredentialStore = createStore(RECENT_ROOM);
      const holder = createGameSessionHolder({ createSession: () => session.value });
      const reentry = createStoredRoomReentry({
        client: createClient(session.value),
        readiness: readyReadiness(),
        sessions: holder,
        sessionCredentialStore,
      });
      reentry.check();
      await flushPromises();
      session.publish({ game: PLAYING_GAME });
      session.resolveConnect({
        ok: false,
        error: { kind: 'server', error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: {} } },
      });
      await flushPromises();
      expect(reentry.getSnapshot().status).toBe('permanentFailure');
      const publishNewGame = () =>
        session.publish({
          game: { ...PLAYING_GAME, stateVersion: 2 as GameSnapshot['stateVersion'] },
        });
      if (arrival === 'Game') publishNewGame();
      else vi.mocked(sessionCredentialStore.removeRoom).mockImplementation(publishNewGame);
      const clear = vi.spyOn(holder, 'clear');
      reentry.confirmPermanentFailure();
      expect(clear).not.toHaveBeenCalled();
      expect(holder.getSnapshot().sessionSnapshot?.game?.stateVersion).toBe(2);
      expect(reentry.getSnapshot()).toEqual({ status: 'idle' });
      if (arrival === 'Game') expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
      reentry.dispose();
      holder.dispose();
    },
  );

  test('does not clear a replacement session with the same authority after pending restore fails', async () => {
    const session = createSessionFixture();
    const replacement = createSessionFixture();
    const createSession = vi.fn(() => session.value);
    const sessionCredentialStore = createStore(RECENT_ROOM);
    const holder = createGameSessionHolder({ createSession });
    const reentry = createStoredRoomReentry({
      client: createClient(session.value),
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore,
    });
    reentry.check();
    await flushPromises();
    session.resolveConnect({
      ok: false,
      error: { kind: 'server', error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: {} } },
    });
    await flushPromises();
    expect(reentry.getSnapshot().status).toBe('permanentFailure');
    holder.clear();
    createSession.mockReturnValueOnce(replacement.value);
    holder.installAuthority({ ...RECENT_ROOM, seatIndex: 0 });
    const clear = vi.spyOn(holder, 'clear');
    reentry.confirmPermanentFailure();
    expect(clear).not.toHaveBeenCalled();
    expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
    expect(holder.getSnapshot().session).toBe(replacement.value);
    reentry.dispose();
    holder.dispose();
  });

  test('includes readiness in attempt duration and closes active disposal before late completion', async () => {
    let time = 100;
    const ready = deferred<Awaited<ReturnType<ServerReadiness['wait']>>>();
    const session = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const client = createClient(session.value);
    const reentry = createStoredRoomReentry({
      client,
      readiness: { wait: () => ready.promise },
      sessions: holder,
      sessionCredentialStore: createStore(RECENT_ROOM),
      now: () => time,
    });
    const attempt = vi.fn();
    reentry.subscribeAttempt(attempt);
    reentry.check();
    time = 200;
    ready.resolve({ ok: true });
    await flushPromises();
    expect(reentry.getSnapshot().status).toBe('connecting');
    time = 350;
    reentry.dispose();
    reentry.dispose();
    session.resolveConnect({ ok: true });
    session.publish({ connection: 'connected', presence: PRESENCE });
    await flushPromises();
    expect(attempt.mock.calls.map(([event]) => event)).toEqual([
      { phase: 'started' },
      { phase: 'finished', outcome: 'cancelled', durationMs: 250 },
    ]);
    expect(session.value.disconnect).toHaveBeenCalledOnce();
    holder.dispose();
  });

  test.each(['before', 'after'] as const)(
    'reports one success with a %s immediate handoff subscriber',
    async (order) => {
      const session = createSessionFixture();
      const holder = createGameSessionHolder({ createSession: () => session.value });
      const reentry = createStoredRoomReentry({
        client: createClient(session.value),
        readiness: readyReadiness(),
        sessions: holder,
        sessionCredentialStore: createStore(RECENT_ROOM),
      });
      const event = vi.fn();
      const handoff = () => {
        if (reentry.getSnapshot().status === 'waiting') reentry.completeHandoff();
      };
      if (order === 'before') reentry.subscribe(handoff);
      reentry.subscribeAttempt(event);
      if (order === 'after') reentry.subscribe(handoff);
      reentry.check();
      reentry.check();
      await flushPromises();
      session.publish({ connection: 'connected', presence: PRESENCE });
      session.resolveConnect({ ok: true });
      await flushPromises();
      session.publish({ presence: PRESENCE });
      expect(reentry.getSnapshot()).toEqual({ status: 'idle' });
      expect(event.mock.calls.map(([value]) => value)).toEqual([
        { phase: 'started' },
        { phase: 'finished', outcome: 'success', durationMs: expect.any(Number) },
      ]);
      reentry.dispose();
      holder.dispose();
    },
  );

  test('reports cancellation once and ignores an old connection after a new attempt starts', async () => {
    const first = createSessionFixture();
    const second = createSessionFixture();
    const createSession = vi.fn().mockReturnValueOnce(first.value).mockReturnValue(second.value);
    const holder = createGameSessionHolder({ createSession });
    const reentry = createStoredRoomReentry({
      client: createClient(first.value),
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore: createStore(RECENT_ROOM),
    });
    const event = vi.fn();
    reentry.subscribeAttempt(event);
    reentry.check();
    await flushPromises();
    holder.clear();
    reentry.check();
    await flushPromises();
    first.resolveConnect({ ok: true });
    first.publish({ connection: 'connected', presence: PRESENCE });
    await flushPromises();
    expect(reentry.getSnapshot().status).toBe('connecting');
    second.publish({ connection: 'connected', presence: PRESENCE });
    second.resolveConnect({ ok: true });
    await flushPromises();
    expect(event.mock.calls.map(([value]) => value)).toEqual([
      { phase: 'started' },
      { phase: 'finished', outcome: 'cancelled', durationMs: expect.any(Number) },
      { phase: 'started' },
      { phase: 'finished', outcome: 'success', durationMs: expect.any(Number) },
    ]);
    reentry.dispose();
    holder.dispose();
  });

  test('reports a permanent failure once before confirmation clears the candidate', async () => {
    const session = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const reentry = createStoredRoomReentry({
      client: createClient(session.value, {
        ok: false,
        error: { kind: 'server', error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: {} } },
      }),
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore: createStore(RECENT_ROOM),
    });
    const event = vi.fn();
    reentry.subscribeAttempt(event);
    reentry.check();
    await flushPromises();
    reentry.confirmPermanentFailure();
    expect(event.mock.calls.map(([value]) => value)).toEqual([
      { phase: 'started' },
      {
        phase: 'finished',
        durationMs: expect.any(Number),
        outcome: 'failure',
        error: { kind: 'server', error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: {} } },
      },
    ]);
    reentry.dispose();
    holder.dispose();
  });

  test('preserves authority and exposes malformed readiness in the failed attempt', async () => {
    const session = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const sessionCredentialStore = createStore(RECENT_ROOM);
    const client = createClient(session.value);
    const reentry = createStoredRoomReentry({
      client,
      readiness: createServerReadiness(
        'https://game.example',
        async () => new Response('not json'),
      ),
      sessions: holder,
      sessionCredentialStore,
    });
    const event = vi.fn();
    reentry.subscribeAttempt(event);
    try {
      reentry.check();
      await vi.waitFor(() => expect(reentry.getSnapshot().status).toBe('refreshRequired'));
      const error = { kind: 'protocol', code: 'INVALID_RESPONSE' };
      expect(reentry.getSnapshot()).toEqual({ status: 'refreshRequired', error });
      expect(event.mock.calls.map(([value]) => value)).toEqual([
        { phase: 'started' },
        { phase: 'finished', outcome: 'failure', durationMs: expect.any(Number), error },
      ]);
      expect(client.resumeRoom).not.toHaveBeenCalled();
      expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
      expect(session.value.connect).not.toHaveBeenCalled();
    } finally {
      reentry.dispose();
      holder.dispose();
    }
  });

  test('blocks fresh admission when recovery storage cannot be read', () => {
    const sessionCredentialStore = createStore(null);
    sessionCredentialStore.refreshRecentRoom = () => ({ status: 'unavailable' });
    const readiness = readyReadiness();
    const session = createSessionFixture();
    const client = createClient(session.value);
    const reentry = createStoredRoomReentry({
      client,
      readiness,
      sessions: createGameSessionHolder({ createSession: () => session.value }),
      sessionCredentialStore,
    });
    reentry.check();
    expect(reentry.getSnapshot()).toEqual({
      status: 'refreshRequired',
      error: null,
      reason: 'storage',
    });
    expect(readiness.wait).not.toHaveBeenCalled();
    expect(client.resumeRoom).not.toHaveBeenCalled();
    expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
  });

  test('does not start readiness without a recent room and deduplicates start', async () => {
    const readiness = readyReadiness();
    const session = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const reentry = createStoredRoomReentry({
      client: createClient(session.value),
      readiness,
      sessions: holder,
      sessionCredentialStore: createStore(null),
    });

    const event = vi.fn();
    reentry.subscribeAttempt(event);
    reentry.check();
    reentry.check();
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({ status: 'idle' });
    expect(readiness.wait).not.toHaveBeenCalled();
    expect(event).not.toHaveBeenCalled();
  });

  test('restores a waiting room only after the current session has an authenticated full sync', async () => {
    const session = createSessionFixture();
    const synchronization = deferred<Awaited<ReturnType<GameSession['synchronize']>>>();
    vi.mocked(session.value.synchronize).mockReturnValue(synchronization.promise);
    const sessionCredentialStore = createStore(RECENT_ROOM);
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const client = createClient(session.value, {
      ok: true,
      data: { seatIndex: 0, view: { room: WAITING_ROOM, game: null, presence: PRESENCE } },
      meta: {},
    });
    const reentry = createStoredRoomReentry({
      client,
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore,
    });

    reentry.check();
    reentry.check();
    await flushPromises();

    expect(client.resumeRoom).toHaveBeenCalledOnce();
    expect(reentry.getSnapshot().status).toBe('connecting');
    expect(sessionCredentialStore.recordRoom).not.toHaveBeenCalled();
    expect(holder.getSnapshot().room).toBe(WAITING_ROOM);

    session.publish({ connection: 'connected', presence: PRESENCE });
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({ status: 'synchronizing' });
    expect(session.value.synchronize).toHaveBeenCalledOnce();

    synchronization.resolve({ ok: true });
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({
      status: 'waiting',
      roomCode: WAITING_ROOM.roomCode,
      expiresAt: WAITING_ROOM.expiresAt,
    });

    reentry.completeHandoff();
    session.resolveConnect({ ok: true });
    reentry.check();
    expect(reentry.getSnapshot()).toEqual({ status: 'idle' });
    expect(client.resumeRoom).toHaveBeenCalledOnce();
  });

  test('ignores the HTTP game payload and hands off to Game only from the current SDK snapshot', async () => {
    const session = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const client = createClient(session.value, {
      ok: true,
      data: { seatIndex: 0, view: { room: PLAYING_ROOM, game: PLAYING_GAME, presence: PRESENCE } },
      meta: {},
    });
    const reentry = createStoredRoomReentry({
      client,
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore: createStore(RECENT_ROOM),
    });

    reentry.check();
    await flushPromises();

    expect(reentry.getSnapshot().status).toBe('connecting');

    session.publish({ connection: 'connected', presence: PRESENCE, game: null });
    await flushPromises();
    expect(reentry.getSnapshot().status).toBe('synchronizing');

    session.publish({ game: PLAYING_GAME });
    session.resolveConnect({ ok: true });
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({ status: 'gameReady' });
  });

  test('re-reads the holder after sync instead of accepting a stale waiting projection', async () => {
    const session = createSessionFixture();
    const synchronization = deferred<Awaited<ReturnType<GameSession['synchronize']>>>();
    vi.mocked(session.value.synchronize).mockReturnValue(synchronization.promise);
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const reentry = createStoredRoomReentry({
      client: createClient(session.value),
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore: createStore(RECENT_ROOM),
    });

    reentry.check();
    await flushPromises();
    session.publish({ connection: 'connected', presence: PRESENCE });
    await flushPromises();
    expect(reentry.getSnapshot()).toEqual({ status: 'synchronizing' });

    session.publish({ game: PLAYING_GAME });
    synchronization.resolve({ ok: true });
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({ status: 'gameReady' });
  });

  test('hands a newly finished authoritative SDK snapshot to Game for Result rendering', async () => {
    const session = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const reentry = createStoredRoomReentry({
      client: createClient(session.value, {
        ok: true,
        data: {
          seatIndex: 0,
          view: { room: PLAYING_ROOM, game: PLAYING_GAME, presence: PRESENCE },
        },
        meta: {},
      }),
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore: createStore(RECENT_ROOM),
    });

    reentry.check();
    await flushPromises();
    session.publish({
      connection: 'connected',
      presence: PRESENCE,
      game: { stateVersion: 2, match: { status: 'finished' } } as GameSnapshot,
    });
    session.resolveConnect({ ok: true });
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({ status: 'gameReady' });
  });

  test('keeps permanent-failure credentials until the user confirms', async () => {
    const session = createSessionFixture();
    const sessionCredentialStore = createStore(RECENT_ROOM);
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const error = {
      kind: 'server' as const,
      error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: {} },
    };
    const reentry = createStoredRoomReentry({
      client: createClient(session.value, { ok: false, error }),
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore,
    });

    reentry.check();
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({ status: 'permanentFailure', error });
    expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();

    reentry.confirmPermanentFailure();
    await flushPromises();

    expect(sessionCredentialStore.removeRoom).toHaveBeenCalledWith(RECENT_ROOM.roomId);
    expect(holder.getSnapshot().authority).toBeNull();
    expect(reentry.getSnapshot()).toEqual({ status: 'idle' });
  });

  test('uses refresh-only after the HTTP client exhausts a transient resume failure', async () => {
    const session = createSessionFixture();
    const sessionCredentialStore = createStore(RECENT_ROOM);
    const error = createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE);
    const reentry = createStoredRoomReentry({
      client: createClient(session.value, { ok: false, error }),
      readiness: readyReadiness(),
      sessions: createGameSessionHolder({ createSession: () => session.value }),
      sessionCredentialStore,
    });

    reentry.check();
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({ status: 'refreshRequired', error });
    expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
  });

  test('ends a completed transient first connection failure without waiting for the budget', async () => {
    vi.useFakeTimers();
    const session = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const reentry = createStoredRoomReentry({
      client: createClient(session.value, {
        ok: true,
        data: {
          seatIndex: 0,
          view: { room: PLAYING_ROOM, game: PLAYING_GAME, presence: PRESENCE },
        },
        meta: {},
      }),
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore: createStore(RECENT_ROOM),
    });

    reentry.check();
    await flushPromises();
    const error = createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE);
    session.publish({ connection: 'disconnected', error });
    session.resolveConnect({ ok: false, error });
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({ status: 'refreshRequired', error });
    expect(session.value.disconnect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10_000);
    session.publish({
      connection: 'connected',
      error: null,
      presence: PRESENCE,
      game: PLAYING_GAME,
    });
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({ status: 'refreshRequired', error });
    reentry.dispose();
    holder.dispose();
  });

  test('ends a completed transient first synchronization failure immediately', async () => {
    const session = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const sessionCredentialStore = createStore(RECENT_ROOM);
    const error = createTransportError(CLIENT_ERROR_CODE.ACK_TIMEOUT);
    vi.mocked(session.value.synchronize).mockResolvedValueOnce({ ok: false, error });
    const reentry = createStoredRoomReentry({
      client: createClient(session.value),
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore,
    });
    reentry.check();
    await flushPromises();
    session.publish({ connection: 'connected', presence: PRESENCE });
    await flushPromises();
    expect(reentry.getSnapshot()).toEqual({ status: 'refreshRequired', error });
    expect(session.value.disconnect).toHaveBeenCalledOnce();
    expect(sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
    session.resolveConnect({ ok: true });
    await flushPromises();
    expect(reentry.getSnapshot()).toEqual({ status: 'refreshRequired', error });
    reentry.dispose();
    holder.dispose();
  });

  test('ends with refresh-only when an unexpected resume rejection escapes the SDK boundary', async () => {
    const session = createSessionFixture();
    const client = createClient(session.value);
    const cause = new Error('transport invariant');
    const onUnexpected = vi.fn();
    vi.mocked(client.resumeRoom).mockRejectedValueOnce(cause);
    const reentry = createStoredRoomReentry({
      client,
      readiness: readyReadiness(),
      sessions: createGameSessionHolder({ createSession: () => session.value }),
      sessionCredentialStore: createStore(RECENT_ROOM),
      onUnexpected,
    });

    reentry.check();
    await flushPromises();

    expect(reentry.getSnapshot()).toEqual({ status: 'refreshRequired', error: null });
    expect(onUnexpected).toHaveBeenCalledExactlyOnceWith(cause);
    reentry.dispose();
  });

  test.each(['readiness', 'connect', 'synchronize'] as const)(
    'reports an active unexpected %s rejection without copying it into recovery state',
    async (stage) => {
      const session = createSessionFixture();
      const readiness = readyReadiness();
      const cause = new TypeError(stage);
      const onUnexpected = vi.fn();
      if (stage === 'readiness') vi.mocked(readiness.wait).mockRejectedValueOnce(cause);
      if (stage === 'connect') vi.mocked(session.value.connect).mockRejectedValueOnce(cause);
      if (stage === 'synchronize')
        vi.mocked(session.value.synchronize).mockRejectedValueOnce(cause);
      const holder = createGameSessionHolder({ createSession: () => session.value });
      const reentry = createStoredRoomReentry({
        client: createClient(session.value),
        readiness,
        sessions: holder,
        sessionCredentialStore: createStore(RECENT_ROOM),
        onUnexpected,
      });
      reentry.check();
      await flushPromises();
      if (stage === 'synchronize') session.publish({ connection: 'connected' });
      await flushPromises();
      expect(reentry.getSnapshot()).toEqual({ status: 'refreshRequired', error: null });
      expect(onUnexpected).toHaveBeenCalledExactlyOnceWith(cause);
      reentry.dispose();
      holder.dispose();
    },
  );

  test('ignores a late unexpected resume rejection after disposal and excludes typed network failure', async () => {
    const session = createSessionFixture();
    const client = createClient(session.value);
    let rejectResume!: (cause: unknown) => void;
    vi.mocked(client.resumeRoom).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectResume = reject;
      }),
    );
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const onUnexpected = vi.fn();
    const reentry = createStoredRoomReentry({
      client,
      sessions: holder,
      readiness: readyReadiness(),
      sessionCredentialStore: createStore(RECENT_ROOM),
      onUnexpected,
    });
    reentry.check();
    await flushPromises();
    reentry.dispose();
    rejectResume(new TypeError('old operation'));
    await flushPromises();
    expect(onUnexpected).not.toHaveBeenCalled();
    holder.dispose();
    const failed = createStoredRoomReentry({
      client: createClient(session.value, {
        ok: false,
        error: createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE),
      }),
      sessions: createGameSessionHolder({ createSession: () => session.value }),
      readiness: readyReadiness(),
      sessionCredentialStore: createStore(RECENT_ROOM),
      onUnexpected,
    });
    failed.check();
    await flushPromises();
    expect(failed.getSnapshot().status).toBe('refreshRequired');
    expect(onUnexpected).not.toHaveBeenCalled();
    failed.dispose();
  });

  test('disconnects a hung session at 30 seconds and ignores late snapshots', async () => {
    vi.useFakeTimers();
    const session = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => session.value });
    const reentry = createStoredRoomReentry({
      client: createClient(session.value, {
        ok: true,
        data: {
          seatIndex: 0,
          view: { room: PLAYING_ROOM, game: PLAYING_GAME, presence: PRESENCE },
        },
        meta: {},
      }),
      readiness: readyReadiness(),
      sessions: holder,
      sessionCredentialStore: createStore(RECENT_ROOM),
    });

    reentry.check();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(session.value.disconnect).toHaveBeenCalledOnce();
    expect(reentry.getSnapshot().status).toBe('refreshRequired');

    session.publish({ connection: 'connected', presence: PRESENCE, game: PLAYING_GAME });
    session.resolveConnect({ ok: true });
    await flushPromises();

    expect(reentry.getSnapshot().status).toBe('refreshRequired');
  });
});

function readyReadiness(): ServerReadiness {
  return { wait: vi.fn(() => Promise.resolve({ ok: true as const })) };
}

function createStore(recentRoom: RecentRoom | null): SessionCredentialStore {
  return {
    removeRoom: vi.fn(() => {}),
    initialize: () => ({
      clientId: 'client-id',
      recentRoom: { status: 'ready', room: recentRoom },
    }),
    getClientId: () => 'client-id',
    refreshRecentRoom: () => ({ status: 'ready', room: recentRoom }),
    recordRoom: vi.fn(),
    getSnapshot: () => ({ persistence: 'saved' }),
    subscribe: () => () => {},
  };
}

function createClient(
  session: GameSession,
  resumeResult: unknown = {
    ok: true,
    data: { seatIndex: 0, view: { room: WAITING_ROOM, game: null, presence: PRESENCE } },
    meta: {},
  },
): GameClient {
  return {
    resumeRoom: vi.fn(() =>
      Promise.resolve(resumeResult as Awaited<ReturnType<GameClient['resumeRoom']>>),
    ),
    createSession: vi.fn(() => session),
  } as unknown as GameClient;
}

function createSessionFixture() {
  let snapshot: GameSessionSnapshot = {
    connection: 'idle',
    syncStatus: 'idle',
    syncRevision: 0,
    room: null,
    game: null,
    presence: null,
    presentation: null,
    error: null,
  };
  const listeners = new Set<() => void>();
  let resolveConnect!: (value: Awaited<ReturnType<GameSession['connect']>>) => void;
  const connection = new Promise<Awaited<ReturnType<GameSession['connect']>>>((resolve) => {
    resolveConnect = resolve;
  });
  const unavailable = () => Promise.resolve({ ok: false as const, error: {} as never });
  const value: GameSession = {
    connect: vi.fn(() => connection),
    disconnect: vi.fn(),
    dispose: vi.fn(),
    synchronize: vi.fn(() => Promise.resolve({ ok: true as const })),
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rollDice: vi.fn(unavailable),
    setDieHeld: vi.fn(unavailable),
    selectScoreCategory: vi.fn(unavailable),
    forfeitMatch: vi.fn(unavailable),
  };
  return {
    value,
    resolveConnect,
    publish(next: Partial<GameSessionSnapshot>) {
      snapshot = { ...snapshot, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
