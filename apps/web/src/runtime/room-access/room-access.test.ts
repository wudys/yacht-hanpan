import type { GameClient, GameSession, GameSessionSnapshot } from '@repo/game-client-sdk';
import { expect, test, vi } from 'vitest';

import { createRoomAccess } from '@/runtime/room-access/room-access';
import type {
  StoredRoomRestore,
  StoredRoomRestoreSnapshot,
} from '@/runtime/room-access/stored-room-restore';
import type { BrowserSessionStore } from '@/runtime/session/browser-session-store';
import { createGameSessionHolder } from '@/runtime/session/session-holder';
import type { SessionRecovery } from '@/runtime/session/session-recovery';
import { observeTelemetry } from '@/runtime/telemetry/observe-telemetry';
import { inactiveTelemetry } from '@/runtime/telemetry/telemetry';
import { authority, playingGame, room, waitingRoom } from '@/testing/game-fixtures';

const profile = { characterId: 'navy-bob', variant: false } as const;
function setup(restore?: StoredRoomRestore) {
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
  const sessionListeners = new Set<() => void>();
  const session = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    dispose: vi.fn(),
    connect: vi.fn(async () => ({ ok: true })),
    disconnect: vi.fn(),
    synchronize: vi.fn(),
  } as unknown as GameSession;
  const client = {
    createSession: vi.fn(() => session),
    createRoom: vi.fn(async () => ({ ok: true, data: { authority, view: { room: waitingRoom } } })),
    joinRoom: vi.fn(),
    cancelRoom: vi.fn(async () => ({ ok: true, data: {}, meta: {} })),
  } as unknown as GameClient;
  const sessions = createGameSessionHolder(client);
  const store = {
    getClientId: () => 'fixture',
    recordRoom: vi.fn(),
    removeRoom: vi.fn(),
  } as unknown as BrowserSessionStore;
  const reentry =
    restore ??
    ({
      check: vi.fn(),
      subscribe: () => () => {},
      getSnapshot: () => ({ status: 'idle' }),
    } as unknown as StoredRoomRestore);
  const readiness = { wait: vi.fn(async () => ({ ok: true as const })) };
  const activity = new AbortController();
  const access = createRoomAccess({
    activity: activity.signal,
    client,
    sessions,
    store,
    readiness,
    restore: reentry,
    recovery: { getSnapshot: () => ({ status: 'idle' }), subscribe: () => () => {} },
  });
  const publishGame = () => {
    snapshot = { ...snapshot, connection: 'connected', room, game: playingGame };
    for (const listener of sessionListeners) listener();
  };
  return { access, activity, client, sessions, session, store, readiness, reentry, publishGame };
}

test('registers admission before publishing so an observer cannot submit a second HTTP mutation', async () => {
  const { access, client, session, sessions } = setup();
  let nested: ReturnType<typeof access.create> | undefined;
  access.subscribe(() => {
    if (access.getSnapshot().status === 'preparing')
      nested = access.create(profile, new AbortController().signal);
  });
  const result = await access.create(profile, new AbortController().signal);
  expect(result.status).toBe('installed');
  expect(await nested).toEqual({ status: 'blocked' });
  expect(client.createRoom).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(session.connect).toHaveBeenCalledOnce());
  expect(sessions.getSnapshot().authority).toEqual(authority);
  access.dispose();
  sessions.dispose();
});

test.each(['route', 'execution'] as const)(
  'does not issue HTTP when %s aborts during a preparation notification',
  async (owner) => {
    const { access, activity, client, readiness } = setup();
    const route = new AbortController();
    access.subscribe(() => {
      if (access.getSnapshot().status === 'preparing')
        (owner === 'route' ? route : activity).abort();
    });
    expect(await access.create(profile, route.signal)).toEqual({ status: 'stale' });
    expect(readiness.wait).not.toHaveBeenCalled();
    expect(client.createRoom).not.toHaveBeenCalled();
    access.dispose();
  },
);

test('does not set a room or connect a session replaced by an installation observer', async () => {
  const { access, client, sessions, session } = setup();
  const setRoom = vi.spyOn(sessions, 'setRoom');
  let changed = false;
  sessions.subscribe(() => {
    if (changed || sessions.getSnapshot().authority === null) return;
    changed = true;
    sessions.installAuthority({
      ...authority,
      roomId: '019cebf0-79b8-7a22-8000-000000000002' as typeof authority.roomId,
    });
  });
  // Distinct instances establish session identity even when an observer replaces authority.
  vi.mocked(client.createSession)
    .mockReturnValueOnce(session)
    .mockReturnValueOnce({ ...session } as GameSession);
  expect(await access.create(profile, new AbortController().signal)).toEqual({ status: 'stale' });
  expect(setRoom).not.toHaveBeenCalled();
  expect(session.connect).not.toHaveBeenCalled();
  access.dispose();
  sessions.dispose();
});

test('does not emit a new admission when authority is installed during readiness', async () => {
  const { access, client, sessions, readiness } = setup();
  let prepared!: (result: { ok: true }) => void;
  vi.mocked(readiness.wait).mockImplementation(
    () =>
      new Promise((resolve) => {
        prepared = resolve;
      }),
  );
  const result = access.create(profile, new AbortController().signal);
  sessions.installAuthority(authority);
  prepared({ ok: true });
  expect(await result).toEqual({ status: 'stale' });
  expect(client.createRoom).not.toHaveBeenCalled();
  access.dispose();
  sessions.dispose();
});

test('keeps authoritative Game when a storage observer publishes it before cancellation clears authority', async () => {
  const { access, store, session, sessions, publishGame } = setup();
  await access.create(profile, new AbortController().signal);
  vi.mocked(store.removeRoom).mockImplementation(() => {
    publishGame();
  });
  const response = vi.fn();
  expect(await access.cancelWaiting(new AbortController().signal, response)).toEqual({
    status: 'matched',
  });
  expect(response).toHaveBeenCalledExactlyOnceWith(undefined);
  expect(sessions.getSnapshot().session).toBe(session);
  expect(session.dispose).not.toHaveBeenCalled();
  access.dispose();
  sessions.dispose();
});

test('does not remove authority when cancellation is aborted before its HTTP response', async () => {
  const { access, activity, client, store, sessions } = setup();
  await access.create(profile, new AbortController().signal);
  let complete!: (value: Awaited<ReturnType<GameClient['cancelRoom']>>) => void;
  vi.mocked(client.cancelRoom).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const response = vi.fn();
  const cancellation = access.cancelWaiting(new AbortController().signal, response);
  activity.abort();
  complete({ ok: true, data: {}, meta: {} } as Awaited<ReturnType<GameClient['cancelRoom']>>);
  expect(await cancellation).toEqual({ status: 'stale' });
  expect(response).not.toHaveBeenCalled();
  expect(store.removeRoom).not.toHaveBeenCalled();
  expect(sessions.getSnapshot().authority).toEqual(authority);
  access.dispose();
  sessions.dispose();
});

test.each(['dispose', 'abort'] as const)(
  'does not confirm authority failure after access %s',
  async (action) => {
    const { access, activity, session, sessions, store } = setup();
    vi.mocked(session.connect).mockResolvedValue({
      ok: false,
      error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } },
    });
    await access.create(profile, new AbortController().signal);
    await vi.waitFor(() => expect(access.getSnapshot().status).toBe('connectionFailure'));
    const clear = vi.spyOn(sessions, 'clear');
    if (action === 'dispose') access.dispose();
    else activity.abort();
    access.confirmAuthorityFailure();
    expect(store.removeRoom).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(sessions.getSnapshot().authority).toEqual(authority);
    access.dispose();
    sessions.dispose();
  },
);

test.each(['stop', 'clear'] as const)(
  'does not begin initial connection after %s wins the deferred start',
  async (action) => {
    const { access, activity, session, sessions } = setup();
    access.subscribe(() => {
      if (access.getSnapshot().status !== 'waiting') return;
      // The first task runs before connect's scheduling task; the second runs before its promise callback.
      queueMicrotask(() =>
        queueMicrotask(() => {
          if (action === 'clear') sessions.clear();
          else activity.abort();
        }),
      );
    });
    expect((await access.create(profile, new AbortController().signal)).status).toBe('installed');
    await Promise.resolve();
    await Promise.resolve();
    expect(session.connect).not.toHaveBeenCalled();
    access.dispose();
    sessions.dispose();
  },
);

test('starts the transport needed for matched sync when cancellation begins before deferred connect', async () => {
  const { access, client, session, sessions, publishGame } = setup();
  let connected = false;
  vi.mocked(session.connect).mockImplementation(async () => {
    connected = true;
    return { ok: true };
  });
  vi.mocked(session.synchronize).mockImplementation(async () => {
    if (!connected) return { ok: false, error: { kind: 'transport', code: 'SOCKET_DISCONNECTED' } };
    publishGame();
    return { ok: true };
  });
  let response!: (value: Awaited<ReturnType<GameClient['cancelRoom']>>) => void;
  vi.mocked(client.cancelRoom).mockImplementation(
    () =>
      new Promise((resolve) => {
        response = resolve;
      }),
  );
  let cancellation: ReturnType<typeof access.cancelWaiting> | undefined;
  access.subscribe(() => {
    if (access.getSnapshot().status !== 'waiting') return;
    queueMicrotask(() => {
      cancellation = access.cancelWaiting(new AbortController().signal, () => {});
    });
  });
  await access.create(profile, new AbortController().signal);
  await Promise.resolve();
  await Promise.resolve();
  response({
    ok: false,
    error: { kind: 'server', error: { code: 'ROOM_ALREADY_MATCHED', params: {} } },
  });
  expect(await cancellation).toEqual({ status: 'matched' });
  expect(session.connect).toHaveBeenCalledOnce();
  expect(session.synchronize).toHaveBeenCalledOnce();
  expect(sessions.getSnapshot().sessionSnapshot?.game).toBe(playingGame);
  expect(sessions.getSnapshot().session).toBe(session);
  access.dispose();
  sessions.dispose();
});

test.each(['before', 'after'] as const)(
  'lets a restore observer registered %s access observe success before handoff consumption',
  async (order) => {
    let state: StoredRoomRestoreSnapshot = { status: 'synchronizing' };
    const listeners = new Set<() => void>();
    const publish = (next: StoredRoomRestoreSnapshot) => {
      state = next;
      for (const listener of listeners) listener();
    };
    const restore: StoredRoomRestore = {
      getSnapshot: () => state,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      subscribeAttempt: () => () => {},
      check() {},
      dispose() {},
      confirmPermanentFailure() {},
      completeHandoff: vi.fn(() => publish({ status: 'idle' })),
    };
    const observations: string[] = [];
    const observer = () => {
      observations.push(restore.getSnapshot().status);
    };
    if (order === 'before') restore.subscribe(observer);
    const { access, sessions, publishGame } = setup(restore);
    if (order === 'after') restore.subscribe(observer);
    const trackEvent = vi.fn();
    const stopTelemetry = observeTelemetry({
      telemetry: { ...inactiveTelemetry, trackEvent },
      sessions,
      restore,
      recovery: { subscribeAttempt: () => () => {} } as unknown as SessionRecovery,
    });
    const accessObserved: string[] = [];
    access.subscribe(() => {
      if (access.getSnapshot().status === 'handoff') access.completeHandoff();
    });
    access.subscribe(() => {
      accessObserved.push(access.getSnapshot().status);
    });
    sessions.installAuthority(authority);
    publishGame();
    expect(access.getSnapshot().status).toBe('restoring');
    publish({ status: 'playing' });
    await Promise.resolve();
    expect(accessObserved).toContain('handoff');
    expect(restore.getSnapshot().status).toBe('playing');
    await Promise.resolve();
    expect(restore.completeHandoff).toHaveBeenCalledOnce();
    expect(observations).toEqual(['playing', 'idle']);
    expect(trackEvent).toHaveBeenCalledWith({ name: 'play_started', entry: 'resumed' });
    stopTelemetry();
    access.dispose();
    sessions.dispose();
  },
);

test('allows a new Lobby admission after matched handoff and Result clear the current session', async () => {
  const { access, client, session, sessions, publishGame } = setup();
  const empty = session.getSnapshot();
  await access.create(profile, new AbortController().signal);
  vi.mocked(client.cancelRoom).mockResolvedValue({
    ok: false,
    error: { kind: 'server', error: { code: 'ROOM_ALREADY_MATCHED', params: {} } },
  });
  vi.mocked(session.synchronize).mockImplementation(async () => {
    publishGame();
    return { ok: true };
  });
  expect(await access.cancelWaiting(new AbortController().signal, () => {})).toEqual({
    status: 'matched',
  });
  expect(access.getSnapshot()).toMatchObject({ status: 'handoff', target: 'game' });
  access.completeHandoff();
  sessions.clear();
  expect(access.getSnapshot()).toEqual({ status: 'idle' });
  vi.mocked(client.createSession).mockReturnValue({ ...session, getSnapshot: () => empty });
  expect((await access.create(profile, new AbortController().signal)).status).toBe('installed');
  expect(client.createRoom).toHaveBeenCalledTimes(2);
  expect(access.getSnapshot().status).toBe('waiting');
  access.dispose();
  sessions.dispose();
});

test('ignores a former session first-connect failure after another session owns Game', async () => {
  const { access, client, sessions, session } = setup();
  let finish!: (result: Awaited<ReturnType<GameSession['connect']>>) => void;
  vi.mocked(session.connect).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await access.create(profile, new AbortController().signal);
  await vi.waitFor(() => expect(session.connect).toHaveBeenCalledOnce());
  const replacement = {
    ...session,
    getSnapshot: () => ({
      ...session.getSnapshot(),
      connection: 'connected' as const,
      room,
      game: playingGame,
    }),
    disconnect: vi.fn(),
  };
  vi.mocked(client.createSession).mockReturnValueOnce(replacement);
  sessions.installAuthority({
    ...authority,
    seatToken: '22222222-2222-4222-8222-222222222222' as typeof authority.seatToken,
  });
  finish({ ok: false, error: { kind: 'transport', code: 'SOCKET_DISCONNECTED' } });
  await Promise.resolve();
  expect(access.getSnapshot()).toMatchObject({ status: 'handoff', target: 'game' });
  expect(replacement.disconnect).not.toHaveBeenCalled();
  expect(session.disconnect).not.toHaveBeenCalled();
  access.dispose();
  sessions.dispose();
});

test.each(['refreshRequired', 'permanentFailure'] as const)(
  'does not let saved restore %s replace another current Game',
  async (failure) => {
    let state: StoredRoomRestoreSnapshot = { status: 'idle' };
    const listeners = new Set<() => void>();
    const restore = {
      check() {},
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as StoredRoomRestore;
    const { access, client, sessions, session, publishGame } = setup(restore);
    sessions.installAuthority(authority);
    state = { status: 'synchronizing' };
    for (const listener of listeners) listener();
    publishGame();
    state =
      failure === 'refreshRequired'
        ? { status: failure, error: { kind: 'protocol', code: 'SESSION_DISPOSED' } }
        : {
            status: failure,
            error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } },
          };
    for (const listener of listeners) listener();
    expect(access.getSnapshot()).toMatchObject({
      status: failure === 'refreshRequired' ? 'refreshRequired' : 'authorityFailure',
      origin: 'restore',
    });
    const replacement = {
      ...session,
      getSnapshot: () => ({ ...session.getSnapshot(), game: playingGame }),
      disconnect: vi.fn(),
    };
    vi.mocked(client.createSession).mockReturnValueOnce(replacement);
    sessions.installAuthority({
      ...authority,
      seatToken: '22222222-2222-4222-8222-222222222222' as typeof authority.seatToken,
    });
    expect(access.getSnapshot()).toMatchObject({
      status: 'handoff',
      origin: 'session',
      target: 'game',
    });
    expect(replacement.disconnect).not.toHaveBeenCalled();
    access.dispose();
    sessions.dispose();
  },
);
