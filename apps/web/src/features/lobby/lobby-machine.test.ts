import type { GameClient, GameSession, GameSessionSnapshot } from '@repo/game-client-sdk';
import { parseJoinRoomResponse, parseResumeRoomResponse } from '@repo/game-protocol/http';
import { parsePresenceSnapshot, parseRoomView } from '@repo/game-protocol/socket';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { expect, test, vi } from 'vitest';
import { createActor, waitFor } from 'xstate';

import {
  createLobbyMachine,
  type LobbyEvent,
  type LobbyServices,
  selectLobbyView,
} from '@/features/lobby/lobby-machine';
import { createServerReadiness } from '@/runtime/network/server-readiness';
import { createProfileSelectionStore } from '@/runtime/profile/profile-selection-store';
import { createRoomAccess } from '@/runtime/room-access/room-access';
import {
  createStoredRoomReentry,
  type StoredRoomReentrySnapshot,
} from '@/runtime/room-access/stored-room-reentry';
import { createGameSessionHolder } from '@/runtime/session/game-session-holder';
import type { RecoveryAttemptEvent } from '@/runtime/session/recovery-attempt';
import {
  createSessionCredentialStore,
  type SessionCredentialStore,
} from '@/runtime/session/session-credential-store';
import { observeSessionTelemetry } from '@/runtime/telemetry/session-telemetry-observer';
import { inactiveTelemetry, type Telemetry } from '@/runtime/telemetry/telemetry';
import { authority, playingGame, room, waitingRoom } from '@/testing/game-fixtures';

function setup(
  overrides: Partial<GameClient> = {},
  telemetry: Telemetry = inactiveTelemetry,
  sessionCredentialStore?: SessionCredentialStore,
) {
  const attemptListeners = new Set<(event: RecoveryAttemptEvent) => void>();
  let reentry: StoredRoomReentrySnapshot = { status: 'idle' };
  const listeners = new Set<() => void>();
  let snapshot: GameSessionSnapshot = {
    connection: 'idle',
    syncStatus: 'idle',
    syncRevision: 1,
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
    disconnect: vi.fn(),
    connect: vi.fn(() => Promise.resolve({ ok: true })),
    synchronize: vi.fn(() => Promise.resolve({ ok: true })),
  } as unknown as GameSession;
  const createSession = vi.fn(() => session);
  const sessions = createGameSessionHolder({ createSession });
  const view = {
    room: { ...waitingRoom, createdAt: 1_000, expiresAt: 10_000 },
    game: null,
    presence: {
      roomId: authority.roomId,
      presenceVersion: 0,
      seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
    },
  };
  const client = {
    createRoom: vi.fn(() => Promise.resolve({ ok: true, data: { authority, view }, meta: {} })),
    joinRoom: vi.fn<GameClient['joinRoom']>(() =>
      Promise.resolve({
        ok: false,
        error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } },
      }),
    ),
    cancelRoom: vi.fn(() =>
      Promise.resolve({ ok: false, error: { kind: 'transport', code: 'NETWORK_UNAVAILABLE' } }),
    ),
    resumeRoom: vi.fn(() => new Promise(() => {})),
    ...overrides,
  } as unknown as GameClient;
  const activity = new AbortController();
  const services = {
    activity: activity.signal,
    client,
    profile: createProfileSelectionStore({ getItem: () => null, setItem: () => {} }, () => 0),
    readiness: { wait: () => Promise.resolve({ ok: true }) },
    sessions,
    sessionCredentialStore: sessionCredentialStore ?? {
      getClientId: () => 'fixture',
      recordRoom: vi.fn(),
      removeRoom: vi.fn(() => {}),
    },
    reentry: {
      subscribeAttempt(listener: (event: RecoveryAttemptEvent) => void) {
        attemptListeners.add(listener);
        return () => attemptListeners.delete(listener);
      },
      getSnapshot: () => reentry,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      check: () => {},
      completeHandoff: () => {
        reentry = { status: 'idle' };
        listeners.forEach((listener) => listener());
      },
    },
    recovery: {
      getSnapshot: () => ({ status: 'idle' }),
      subscribe: () => () => {},
      subscribeAttempt: () => () => {},
    },
  } as unknown as Omit<LobbyServices, 'access'> & {
    client: GameClient;
    sessions: ReturnType<typeof createGameSessionHolder>;
    sessionCredentialStore: SessionCredentialStore;
    readiness: ReturnType<typeof createServerReadiness>;
    reentry: ReturnType<typeof createStoredRoomReentry>;
    recovery: import('@/runtime/session/session-recovery').SessionRecovery;
  };
  const baseServices = sessionCredentialStore
    ? { ...services, reentry: createStoredRoomReentry({ ...services, sessionCredentialStore }) }
    : services;
  const admissionServices = {
    ...baseServices,
    access: createRoomAccess({ ...baseServices, reentry: baseServices.reentry }),
  };
  const navigate = vi.fn();
  const actor = createActor(createLobbyMachine(admissionServices, telemetry, navigate));
  actor.start();
  return {
    actor,
    activity,
    services: admissionServices,
    createSession,
    publishAttempt: (event: RecoveryAttemptEvent) =>
      attemptListeners.forEach((listener) => listener(event)),
    publishGame: () => {
      const view = {
        room,
        game: playingGame,
        presence: parsePresenceSnapshot({
          roomId: authority.roomId,
          presenceVersion: 1,
          seats: [{ status: 'connected' }, { status: 'connected' }],
        }),
      };
      parseRoomView(view);
      snapshot = { ...snapshot, connection: 'connected', ...view };
      sessionListeners.forEach((listener) => listener());
    },
    client,
    session,
    navigate,
    publish: (next: StoredRoomReentrySnapshot) => {
      reentry = next;
      listeners.forEach((listener) => listener());
    },
  };
}

test('keeps transport available for matched synchronization when initial connect fails during cancellation', async () => {
  let completeConnection!: (result: Awaited<ReturnType<GameSession['connect']>>) => void;
  let completeCancellation!: (result: Awaited<ReturnType<GameClient['cancelRoom']>>) => void;
  const connection = new Promise<Awaited<ReturnType<GameSession['connect']>>>((resolve) => {
    completeConnection = resolve;
  });
  const cancelRoom = vi.fn<GameClient['cancelRoom']>(
    () =>
      new Promise((resolve) => {
        completeCancellation = resolve;
      }),
  );
  const { actor, session, navigate, publishGame, services } = setup({ cancelRoom });
  vi.mocked(session.connect).mockReturnValue(connection);
  vi.mocked(session.synchronize).mockImplementation(async () => {
    publishGame();
    return { ok: true };
  });
  actor.send({ type: 'CREATE_REQUESTED' });
  await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
  actor.send({ type: 'CANCEL_REQUESTED' });
  await vi.waitFor(() => expect(cancelRoom).toHaveBeenCalledOnce());
  completeConnection({ ok: false, error: { kind: 'transport', code: 'NETWORK_UNAVAILABLE' } });
  await connection;
  await Promise.resolve();
  expect(session.disconnect).not.toHaveBeenCalled();
  completeCancellation({
    ok: false,
    error: { kind: 'server', error: { code: 'ROOM_ALREADY_MATCHED', params: {} } },
  });
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(session.synchronize).toHaveBeenCalledOnce();
  expect(services.sessions.getSnapshot().session).toBe(session);
  services.access.dispose();
  actor.stop();
  services.sessions.dispose();
});

test.each([
  'create-readiness',
  'join-readiness',
  'create',
  'join',
  'connect',
  'cancel',
  'expiry',
] as const)(
  'reports the original unexpected %s failure once and keeps a refresh-only notice',
  async (stage) => {
    const cause = new TypeError(`${stage} invariant`);
    const reportUnexpected = vi.fn();
    const trackEvent = vi.fn();
    const overrides = {
      ...(stage === 'create' ? { createRoom: () => Promise.reject(cause) } : {}),
      ...(stage === 'join' ? { joinRoom: () => Promise.reject(cause) } : {}),
      ...(stage === 'cancel' ? { cancelRoom: () => Promise.reject(cause) } : {}),
      ...(stage === 'expiry' ? { resumeRoom: () => Promise.reject(cause) } : {}),
    } satisfies Partial<GameClient>;
    const { actor, services, session } = setup(overrides, {
      ...inactiveTelemetry,
      reportUnexpected,
      trackEvent,
    });
    actor.subscribe({ error: () => {} });
    if (stage.endsWith('readiness')) services.readiness.wait = () => Promise.reject(cause);
    if (stage === 'connect') vi.mocked(session.connect).mockRejectedValueOnce(cause);
    if (stage.startsWith('join')) {
      actor.send({ type: 'OPEN_JOIN_ROOM' });
      actor.send({ type: 'JOIN_CODE_CHANGED', code: '001234' });
      actor.send({ type: 'JOIN_REQUESTED' });
    } else {
      actor.send({ type: 'CREATE_REQUESTED' });
    }
    if (stage === 'cancel' || stage === 'expiry') {
      await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
      if (stage === 'cancel') actor.send({ type: 'CANCEL_REQUESTED' });
      else {
        actor.send({ type: 'WAIT_EXPIRED' });
        actor.send({ type: 'DISMISS_NOTICE' });
      }
    }
    await waitFor(actor, (state) => state.status === 'error' || state.matches('connectionFailed'));
    const operation = stage.startsWith('create')
      ? 'create'
      : stage.startsWith('join')
        ? 'join'
        : stage === 'cancel'
          ? 'cancel'
          : 'synchronize';
    expect(reportUnexpected).toHaveBeenCalledExactlyOnceWith(cause, {
      operation,
      stage: 'promise',
    });
    const failures = trackEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.name === 'room_request' && event.phase === 'failure');
    expect(failures).toEqual(
      operation === 'create' || operation === 'join'
        ? [{ name: 'room_request', operation, phase: 'failure', duration_ms: expect.any(Number) }]
        : [],
    );
    expect(actor.getSnapshot().matches('connectionFailed')).toBe(true);
    expect(actor.getSnapshot().context.error).toEqual({
      kind: 'request',
      key: 'lobby.reentryRefresh',
    });
    actor.stop();
    services.sessions.dispose();
  },
);

test('keeps the cancellation HTTP result once when its follow-up sync rejects unexpectedly', async () => {
  const cause = new TypeError('synchronization invariant');
  const reportUnexpected = vi.fn();
  const trackEvent = vi.fn();
  const { actor, session, services } = setup(
    {
      cancelRoom: async () => ({
        ok: false,
        error: { kind: 'server', error: { code: 'ROOM_ALREADY_MATCHED', params: {} } },
      }),
    },
    { ...inactiveTelemetry, reportUnexpected, trackEvent },
  );
  try {
    actor.send({ type: 'CREATE_REQUESTED' });
    await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
    vi.mocked(session.synchronize).mockRejectedValueOnce(cause);
    actor.send({ type: 'CANCEL_REQUESTED' });
    await waitFor(actor, (state) => state.matches('connectionFailed'));
    expect(
      trackEvent.mock.calls.map(([event]) => event).filter((event) => event.operation === 'cancel'),
    ).toEqual([
      { name: 'room_request', operation: 'cancel', phase: 'start' },
      {
        name: 'room_request',
        operation: 'cancel',
        phase: 'failure',
        duration_ms: expect.any(Number),
        failure_kind: 'server',
        failure_code: 'ROOM_ALREADY_MATCHED',
      },
    ]);
    expect(reportUnexpected).toHaveBeenCalledExactlyOnceWith(cause, {
      operation: 'cancel',
      stage: 'promise',
    });
  } finally {
    actor.stop();
    services.sessions.dispose();
  }
});

test.each([
  ['cancel', 'match handoff'],
  ['cancel', 'session replacement'],
  ['cancel', 'activity abort'],
  ['connect', 'session replacement'],
  ['expiry', 'session replacement'],
] as const)('ignores %s rejection after %s', async (operation, ending) => {
  let rejectOperation!: (error: Error) => void;
  const pending = () =>
    new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
  const reportUnexpected = vi.fn();
  const { actor, services, publishGame, navigate, activity, session, createSession } = setup(
    {
      ...(operation === 'cancel' ? { cancelRoom: pending } : {}),
      ...(operation === 'expiry' ? { resumeRoom: pending } : {}),
    },
    { ...inactiveTelemetry, reportUnexpected },
  );
  if (operation === 'connect') vi.mocked(session.connect).mockImplementationOnce(pending);
  actor.send({ type: 'CREATE_REQUESTED' });
  await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
  if (operation === 'cancel') actor.send({ type: 'CANCEL_REQUESTED' });
  if (operation === 'expiry') {
    actor.send({ type: 'WAIT_EXPIRED' });
    actor.send({ type: 'DISMISS_NOTICE' });
  }
  if (ending === 'match handoff') publishGame();
  else if (ending === 'activity abort') activity.abort();
  else {
    createSession.mockReturnValueOnce({ ...session });
    services.sessions.installAuthority({
      ...authority,
      roomId: '01991e1b-4f4f-7000-8000-000000000002' as typeof authority.roomId,
    });
  }
  rejectOperation(new TypeError('late operation'));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(navigate).toHaveBeenCalledTimes(ending === 'match handoff' ? 1 : 0);
  expect(reportUnexpected).not.toHaveBeenCalled();
  expect(actor.getSnapshot().status).toBe(ending === 'session replacement' ? 'active' : 'done');
  actor.stop();
  services.sessions.dispose();
});

test.each(['create', 'join', 'newCreate'] as const)(
  'checks a newly saved candidate before %s and keeps profile/settings reads local',
  async (intent) => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const first = createSessionCredentialStore({ storage });
    const second = createSessionCredentialStore({ storage });
    second.initialize();
    const createRoom = vi.fn<GameClient['createRoom']>(() =>
      Promise.resolve({
        ok: false,
        error: { kind: 'transport', code: 'NETWORK_UNAVAILABLE' },
      }),
    );
    const { actor, client, services } = setup({ createRoom }, inactiveTelemetry, second);
    try {
      actor.send({ type: 'OPEN_PROFILE' });
      actor.send({ type: 'CLOSE_PROFILE' });
      actor.send({ type: 'OPEN_SETTINGS' });
      actor.send({ type: 'CLOSE_SETTINGS' });
      expect(client.resumeRoom).not.toHaveBeenCalled();
      if (intent === 'newCreate') {
        actor.send({ type: 'CREATE_REQUESTED' });
        await waitFor(actor, (state) => state.matches('createFailed'));
        actor.send({ type: 'DISMISS_NOTICE' });
        expect(actor.getSnapshot().matches('home')).toBe(true);
        createRoom.mockClear();
      }
      first.recordRoom(authority);
      if (intent === 'join') {
        actor.send({ type: 'OPEN_JOIN_ROOM' });
        actor.send({ type: 'JOIN_CODE_CHANGED', code: '001234' });
        actor.send({ type: 'JOIN_REQUESTED' });
      } else actor.send({ type: 'CREATE_REQUESTED' });
      await vi.waitFor(() => expect(client.resumeRoom).toHaveBeenCalledOnce());
      expect(client.resumeRoom).toHaveBeenCalledWith(
        { roomId: authority.roomId, seatToken: authority.seatToken },
        { signal: expect.any(AbortSignal) },
      );
      expect(createRoom).not.toHaveBeenCalled();
      expect(client.joinRoom).not.toHaveBeenCalled();
    } finally {
      actor.stop();
      services.reentry.dispose();
    }
  },
);

test('blocks admission if the previously readable recovery storage becomes unavailable', async () => {
  const storage = { getItem: vi.fn(() => null), setItem() {}, removeItem() {} };
  const sessionCredentialStore = createSessionCredentialStore({ storage });
  const { actor, client, services } = setup({}, inactiveTelemetry, sessionCredentialStore);
  try {
    storage.getItem.mockImplementation(() => {
      throw new Error('denied');
    });
    actor.send({ type: 'CREATE_REQUESTED' });
    await Promise.resolve();
    expect(services.reentry.getSnapshot()).toEqual({
      status: 'refreshRequired',
      reason: 'storage',
      error: null,
    });
    expect(client.createRoom).not.toHaveBeenCalled();
    expect(client.resumeRoom).not.toHaveBeenCalled();
  } finally {
    actor.stop();
    services.reentry.dispose();
  }
});

test('allows fresh admission after confirming a permanently unavailable recovery candidate', async () => {
  const values = new Map<string, string>();
  const sessionCredentialStore = createSessionCredentialStore({
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  });
  sessionCredentialStore.recordRoom(authority);
  const resumeRoom = vi.fn<GameClient['resumeRoom']>(() =>
    Promise.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'RESUME_NOT_AVAILABLE', params: {} } },
    }),
  );
  const { actor, client, services } = setup(
    { resumeRoom },
    inactiveTelemetry,
    sessionCredentialStore,
  );
  try {
    await vi.waitFor(() => expect(services.reentry.getSnapshot().status).toBe('permanentFailure'));
    services.reentry.confirmPermanentFailure();
    actor.send({ type: 'CREATE_REQUESTED' });
    await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
    expect(resumeRoom).toHaveBeenCalledOnce();
    expect(client.createRoom).toHaveBeenCalledOnce();
  } finally {
    actor.stop();
    services.reentry.dispose();
  }
});

test('owns creation through waiting without storing room authority in form context', async () => {
  const { actor, session } = setup();
  actor.send({ type: 'CREATE_REQUESTED' });
  expect(selectLobbyView(actor.getSnapshot())).toBe('creating');
  await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
  expect(actor.getSnapshot().context.waitingRoom).toEqual({
    roomCode: '001234',
    expiresAt: 10_000,
  });
  expect(actor.getSnapshot().context).not.toHaveProperty('authority');
  expect(session.connect).toHaveBeenCalledOnce();
  actor.stop();
});

test('connects a newly joined session before handing off its authoritative game once', async () => {
  const response = parseJoinRoomResponse({
    ok: true,
    data: {
      authority: { ...authority, seatIndex: 1 },
      view: {
        room,
        game: playingGame,
        presence: {
          roomId: authority.roomId,
          presenceVersion: 1,
          seats: [{ status: 'connected' }, { status: 'connected' }],
        },
      },
    },
    meta: {
      requestId: '11111111-1111-4111-8111-000000000003',
      serverTime: 10_000,
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
    },
  });
  if (!response.ok) throw new Error('Expected a successful join fixture');
  const { actor, session, publishGame, navigate } = setup({
    joinRoom: vi.fn<GameClient['joinRoom']>(() => Promise.resolve(response)),
  });
  actor.send({ type: 'OPEN_JOIN_ROOM' });
  actor.send({ type: 'JOIN_CODE_CHANGED', code: '001234' });
  actor.send({ type: 'JOIN_REQUESTED' });
  await waitFor(actor, (state) => state.matches({ admitted: 'matching' }));
  expect(session.connect).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
  publishGame();
  await waitFor(actor, (state) => state.status === 'done');
  publishGame();
  expect(navigate).toHaveBeenCalledOnce();
  actor.stop();
});

test.each(['waiting entry', 'session capture'] as const)(
  'adopts resumed waiting without another sync when reentry is consumed at %s',
  async (consumeAt) => {
    const { actor, services, session, publish, publishGame, navigate } = setup();
    services.sessions.installAuthority(authority);
    if (consumeAt === 'session capture') {
      const current = services.sessions.getSnapshot();
      // Another owner consumes root success before admitted's invoked work starts.
      vi.spyOn(services.sessions, 'getSnapshot').mockImplementationOnce(() => {
        services.reentry.completeHandoff();
        return current;
      });
    }
    publish({ status: 'waiting', roomCode: '001234', expiresAt: 10_000 });
    await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
    expect(actor.getSnapshot().context.waitingRoom?.roomCode).toBe('001234');
    expect(services.reentry.getSnapshot().status).toBe('idle');
    expect(session.connect).not.toHaveBeenCalled();
    expect(session.synchronize).not.toHaveBeenCalled();
    publishGame();
    await waitFor(actor, (state) => state.status === 'done');
    publish({ status: 'playing' });
    expect(navigate).toHaveBeenCalledOnce();
    actor.stop();
  },
);

test('normalizes a join code and preserves it after an invoked retryable failure', async () => {
  const trackEvent = vi.fn();
  const { actor } = setup({}, { ...inactiveTelemetry, trackEvent });
  actor.send({ type: 'OPEN_JOIN_ROOM' });
  actor.send({ type: 'JOIN_CODE_CHANGED', code: '0a0123456' });
  actor.send({ type: 'JOIN_REQUESTED' });
  expect(selectLobbyView(actor.getSnapshot())).toBe('joining');
  await waitFor(actor, (state) => state.matches('joinRoom'));
  expect(actor.getSnapshot().context).toMatchObject({
    joinCode: '001234',
    error: { kind: 'request', key: 'error.roomNotFound' },
  });
  expect(trackEvent.mock.calls.map(([event]) => event)).toEqual([
    { name: 'room_request', operation: 'join', phase: 'start' },
    {
      name: 'room_request',
      operation: 'join',
      phase: 'failure',
      duration_ms: expect.any(Number),
      failure_kind: 'server',
      failure_code: 'ROOM_NOT_FOUND',
    },
  ]);
  actor.stop();
});

test('keeps admission success separate from a failed initial connection', async () => {
  const trackEvent = vi.fn();
  const { actor, session } = setup({}, { ...inactiveTelemetry, trackEvent });
  vi.mocked(session.connect).mockResolvedValue({
    ok: false,
    error: { kind: 'transport', code: 'NETWORK_UNAVAILABLE' },
  });
  try {
    actor.send({ type: 'CREATE_REQUESTED' });
    await waitFor(actor, (state) => state.matches('connectionFailed'));
    expect(actor.getSnapshot().context.error).toEqual({
      kind: 'request',
      key: 'lobby.reentryRefresh',
    });
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(
      trackEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.name === 'room_request'),
    ).toEqual([
      { name: 'room_request', operation: 'create', phase: 'start' },
      {
        name: 'room_request',
        operation: 'create',
        phase: 'success',
        duration_ms: expect.any(Number),
      },
    ]);
  } finally {
    actor.stop();
  }
});

test('closes waiting immediately while cancellation runs and offers retry only after failure', async () => {
  const { actor } = setup();
  actor.send({ type: 'CREATE_REQUESTED' });
  await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
  actor.send({ type: 'CANCEL_REQUESTED' });
  expect(selectLobbyView(actor.getSnapshot())).toBe('cancelling');
  await waitFor(actor, (state) => state.matches({ admitted: 'cancelFailed' }));
  actor.send({ type: 'OPEN_PROFILE' });
  expect(selectLobbyView(actor.getSnapshot())).toBe('cancelFailed');
  actor.send({ type: 'RETRY_CANCEL' });
  expect(selectLobbyView(actor.getSnapshot())).toBe('cancelling');
  actor.stop();
});

test('retains the rate-limit delay for join resubmission', async () => {
  const { actor } = setup({
    joinRoom: vi.fn<GameClient['joinRoom']>(() =>
      Promise.resolve({
        ok: false,
        error: { kind: 'server', error: { code: 'RATE_LIMITED', params: { retryAfterMs: 2_200 } } },
      }),
    ),
  });
  actor.send({ type: 'OPEN_JOIN_ROOM' });
  actor.send({ type: 'JOIN_CODE_CHANGED', code: '000001' });
  actor.send({ type: 'JOIN_REQUESTED' });
  await waitFor(actor, (state) => state.matches('joinRoom'));
  expect(actor.getSnapshot().context.error).toEqual({
    kind: 'rate-limited',
    retryAfterMs: 2_200,
  });
  actor.stop();
});

test('only accepts six ASCII digits for join submission', () => {
  const { actor } = setup();
  actor.send({ type: 'OPEN_JOIN_ROOM' });
  actor.send({ type: 'JOIN_CODE_CHANGED', code: '１２３４５６' });
  actor.send({ type: 'JOIN_REQUESTED' });
  expect(actor.getSnapshot().matches('joinRoom')).toBe(true);
  actor.send({ type: 'JOIN_CODE_CHANGED', code: '000001' });
  actor.send({ type: 'JOIN_REQUESTED' });
  expect(selectLobbyView(actor.getSnapshot())).toBe('joining');
  actor.stop();
});

test('lets every root observer see resumed success before the single route handoff', async () => {
  const { actor, services, publish, publishAttempt, publishGame, navigate } = setup();
  const trackEvent = vi.fn();
  // Subscribe after the machine to exercise the adverse subscriber order.
  const stop = observeSessionTelemetry({
    ...services,
    reentry: services.reentry,
    telemetry: { ...inactiveTelemetry, trackEvent },
  });
  publishAttempt({ phase: 'started' });
  publish({ status: 'synchronizing' });
  services.sessions.installAuthority(authority);
  publishGame();
  await Promise.resolve();
  expect(navigate).not.toHaveBeenCalled();
  publishAttempt({ phase: 'finished', outcome: 'success', durationMs: 12 });
  publish({ status: 'playing' });
  await waitFor(actor, (state) => state.status === 'done');
  expect(navigate).toHaveBeenCalledOnce();
  expect(trackEvent.mock.calls.map(([event]) => event)).toEqual([
    { name: 'recovery_started', operation: 'reentry' },
    { name: 'play_started', entry: 'resumed' },
    {
      name: 'recovery_result',
      operation: 'reentry',
      outcome: 'success',
      duration_ms: expect.any(Number),
    },
  ]);
  stop();
  services.sessions.dispose();
});

test('stopping cancellation aborts its HTTP call', async () => {
  const cancelRoom = vi.fn<GameClient['cancelRoom']>(() => new Promise(() => {}));
  const { actor } = setup({ cancelRoom });
  actor.send({ type: 'CREATE_REQUESTED' });
  await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
  actor.send({ type: 'CANCEL_REQUESTED' });
  const signal = cancelRoom.mock.calls[0]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  actor.stop();
  expect(signal?.aborted).toBe(true);
});

test('a same-tick authoritative game wins over the local expiry timer', async () => {
  const trackEvent = vi.fn();
  const { actor, publishGame, navigate } = setup({}, { ...inactiveTelemetry, trackEvent });
  actor.send({ type: 'CREATE_REQUESTED' });
  await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
  publishGame();
  actor.send({ type: 'WAIT_EXPIRED' });
  expect(selectLobbyView(actor.getSnapshot())).not.toBe('expired');
  await waitFor(actor, (state) => state.status === 'done');
  expect(navigate).toHaveBeenCalledOnce();
  expect(
    trackEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.name === 'waiting_result'),
  ).toEqual([{ name: 'waiting_result', outcome: 'matched', duration_ms: expect.any(Number) }]);
});

test('counts the whole waiting period after the server rejects local expiry', async () => {
  let now = 1_000;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const trackEvent = vi.fn();
  const resumeRoom = vi.fn<GameClient['resumeRoom']>(async () => {
    const result = parseResumeRoomResponse({
      ok: true,
      data: {
        seatIndex: 0,
        view: {
          room: waitingRoom,
          game: null,
          presence: {
            roomId: authority.roomId,
            presenceVersion: 1,
            seats: [{ status: 'connected' }],
          },
        },
      },
      meta: {
        requestId: '11111111-1111-4111-8111-000000000003',
        serverTime: 10_000,
        gameProtocolVersion: GAME_PROTOCOL_VERSION,
      },
    });
    if (!result.ok) throw new Error('Expected a waiting resume fixture');
    return result;
  });
  const { actor, services, publishGame } = setup(
    { resumeRoom },
    { ...inactiveTelemetry, trackEvent },
  );
  try {
    actor.send({ type: 'CREATE_REQUESTED' });
    await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
    now = 11_000;
    actor.send({ type: 'WAIT_EXPIRED' });
    actor.send({ type: 'DISMISS_NOTICE' });
    await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
    now = 21_000;
    publishGame();
    await waitFor(actor, (state) => state.status === 'done');
    expect(
      trackEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.name === 'waiting_result'),
    ).toEqual([{ name: 'waiting_result', outcome: 'matched', duration_ms: 20_000 }]);
  } finally {
    actor.stop();
    services.sessions.dispose();
    clock.mockRestore();
  }
});

test.each([
  ['created', 'expired'],
  ['resumed', 'expired'],
  ['created', 'notice'],
  ['resumed', 'notice'],
] as const)('dismisses a %s room %s without clearing its replacement', async (origin, notice) => {
  const { actor, services, publish, createSession, session } = setup({
    cancelRoom: vi.fn<GameClient['cancelRoom']>(() =>
      Promise.resolve({
        ok: false,
        error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } },
      }),
    ),
  });
  if (origin === 'created') actor.send({ type: 'CREATE_REQUESTED' });
  else {
    services.sessions.installAuthority(authority);
    publish({ status: 'waiting', roomCode: '001234', expiresAt: 10_000 });
  }
  await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
  if (origin === 'resumed') expect(session.connect).not.toHaveBeenCalled();
  actor.send({ type: notice === 'expired' ? 'WAIT_EXPIRED' : 'CANCEL_REQUESTED' });
  await waitFor(actor, (state) => selectLobbyView(state) === notice);
  const replacement = { ...session };
  createSession.mockReturnValueOnce(replacement);
  services.sessions.installAuthority({
    ...authority,
    roomId: 'replacement-room' as typeof authority.roomId,
  });
  actor.send({ type: 'DISMISS_NOTICE' });
  expect(services.sessions.getSnapshot().session).toBe(replacement);
  expect(services.sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
  actor.stop();
  services.sessions.dispose();
});

test('confirmation cannot clear a game published after local expiry but before source handoff', async () => {
  const { actor, services, publishGame, navigate } = setup();
  actor.send({ type: 'CREATE_REQUESTED' });
  await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
  actor.send({ type: 'WAIT_EXPIRED' });
  publishGame();
  actor.send({ type: 'DISMISS_NOTICE' });
  expect(services.sessions.getSnapshot().sessionSnapshot?.game).toBe(playingGame);
  await waitFor(actor, (state) => state.status === 'done');
  expect(navigate).toHaveBeenCalledOnce();
});

test('expiry confirmation waits for the server and preserves a late matched credential', async () => {
  let finish!: (value: Awaited<ReturnType<GameClient['resumeRoom']>>) => void;
  const resumeRoom = vi.fn<GameClient['resumeRoom']>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { actor, services, publishGame, navigate } = setup({ resumeRoom });
  actor.send({ type: 'CREATE_REQUESTED' });
  await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
  actor.send({ type: 'WAIT_EXPIRED' });
  actor.send({ type: 'DISMISS_NOTICE' });
  expect(resumeRoom).toHaveBeenCalledOnce();
  expect(resumeRoom).toHaveBeenCalledWith(
    { roomId: authority.roomId, seatToken: authority.seatToken },
    { signal: expect.any(AbortSignal) },
  );
  expect(services.sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
  actor.send({ type: 'CREATE_REQUESTED' });
  expect(services.client.createRoom).toHaveBeenCalledOnce();
  publishGame();
  await waitFor(actor, (state) => state.status === 'done');
  finish({ ok: false, error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } } });
  await Promise.resolve();
  expect(services.sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledOnce();
});

test.each(['NETWORK_UNAVAILABLE', 'ROOM_NOT_FOUND'] as const)(
  'expiry confirmation handles %s without guessing server expiry',
  async (code) => {
    const resumeRoom = vi.fn<GameClient['resumeRoom']>(async () => ({
      ok: false,
      error:
        code === 'NETWORK_UNAVAILABLE'
          ? { kind: 'transport', code }
          : { kind: 'server', error: { code, params: {} } },
    }));
    const { actor, services } = setup({ resumeRoom });
    actor.send({ type: 'CREATE_REQUESTED' });
    await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
    actor.send({ type: 'WAIT_EXPIRED' });
    actor.send({ type: 'DISMISS_NOTICE' });
    await waitFor(actor, (state) =>
      state.matches(code === 'ROOM_NOT_FOUND' ? 'home' : 'connectionFailed'),
    );
    expect(services.sessionCredentialStore.removeRoom).toHaveBeenCalledTimes(
      code === 'ROOM_NOT_FOUND' ? 1 : 0,
    );
    actor.stop();
  },
);

test('losing tab ownership aborts admission and ignores a late successful response', async () => {
  let finish!: (value: Awaited<ReturnType<GameClient['createRoom']>>) => void;
  const createRoom = vi.fn<GameClient['createRoom']>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { actor, services, activity } = setup({ createRoom });
  actor.send({ type: 'CREATE_REQUESTED' });
  await waitFor(actor, (state) => state.matches('creating'));
  const signal = createRoom.mock.calls[0]?.[1]?.signal;
  activity.abort();
  expect(signal?.aborted).toBe(true);
  finish({ ok: true, data: { authority, view: { room: {} } }, meta: {} } as Awaited<
    ReturnType<GameClient['createRoom']>
  >);
  await Promise.resolve();
  actor.send({ type: 'CREATE_REQUESTED' });
  expect(createRoom).toHaveBeenCalledOnce();
  expect(services.sessionCredentialStore.recordRoom).not.toHaveBeenCalled();
  expect(actor.getSnapshot().matches('replaced')).toBe(true);
});

test('reports malformed waiting-room expiry responses and preserves the refresh-only failure', async () => {
  const reportUnexpected = vi.fn();
  const { actor } = setup(
    {
      resumeRoom: async () => ({
        ok: false,
        error: { kind: 'protocol', code: 'INVALID_RESPONSE' },
      }),
    },
    { ...inactiveTelemetry, reportUnexpected },
  );
  try {
    actor.send({ type: 'CREATE_REQUESTED' });
    await waitFor(actor, (state) => state.matches({ admitted: 'waiting' }));
    actor.send({ type: 'WAIT_EXPIRED' });
    actor.send({ type: 'DISMISS_NOTICE' });
    await waitFor(actor, (state) => state.matches('connectionFailed'));
    expect(reportUnexpected.mock.calls).toEqual([
      [
        expect.objectContaining({ message: 'INVALID_RESPONSE' }),
        {
          operation: 'synchronize',
          stage: 'response',
          error_code: 'INVALID_RESPONSE',
        },
      ],
    ]);
  } finally {
    actor.stop();
  }
});

test.each<{ operation: 'create' | 'join'; events: LobbyEvent[] }>([
  { operation: 'create', events: [{ type: 'CREATE_REQUESTED' }] },
  {
    operation: 'join',
    events: [
      { type: 'OPEN_JOIN_ROOM' },
      { type: 'JOIN_CODE_CHANGED', code: '001234' },
      { type: 'JOIN_REQUESTED' },
    ],
  },
])(
  'reports malformed readiness before $operation without issuing a mutation',
  async ({ operation, events }) => {
    const reportUnexpected = vi.fn();
    const trackEvent = vi.fn();
    const { actor, services, client } = setup(
      {},
      { ...inactiveTelemetry, reportUnexpected, trackEvent },
    );
    vi.spyOn(services.readiness, 'wait').mockImplementation(
      createServerReadiness('https://game.example', async () => new Response('not json')).wait,
    );
    try {
      for (const event of events) actor.send(event);
      await waitFor(actor, (state) => state.matches('connectionFailed'));
      expect(client.createRoom).not.toHaveBeenCalled();
      expect(client.joinRoom).not.toHaveBeenCalled();
      expect(trackEvent.mock.calls.map(([event]) => event)).toEqual([
        { name: 'room_request', operation, phase: 'start' },
        {
          name: 'room_request',
          operation,
          phase: 'failure',
          duration_ms: expect.any(Number),
          failure_kind: 'protocol',
          failure_code: 'INVALID_RESPONSE',
        },
      ]);
      expect(reportUnexpected.mock.calls).toEqual([
        [
          expect.objectContaining({ message: 'INVALID_RESPONSE' }),
          { operation, stage: 'response', error_code: 'INVALID_RESPONSE' },
        ],
      ]);
    } finally {
      actor.stop();
    }
  },
);

test('uses connection recovery copy when the initial SDK full sync was cancelled', async () => {
  const { actor, session, services } = setup();
  vi.mocked(session.connect).mockResolvedValueOnce({
    ok: false,
    error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
  });
  actor.send({ type: 'CREATE_REQUESTED' });
  await waitFor(actor, (state) => state.matches('connectionFailed'));
  expect(actor.getSnapshot().context.error).toEqual({
    kind: 'request',
    key: 'lobby.reentryRefresh',
  });
  expect(session.disconnect).toHaveBeenCalledOnce();
  actor.stop();
  services.sessions.dispose();
});
