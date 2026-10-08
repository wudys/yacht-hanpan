import type {
  GameClient,
  GameSession,
  GameSessionSnapshot,
  RoomAuthority,
} from '@repo/game-client-sdk';
import { CLIENT_ERROR_CODE, type ClientError } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import type { GameSnapshot } from '@repo/game-protocol/state';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { createGameSessionHolder } from '@/runtime/session/game-session-holder';
import { createSessionRecovery } from '@/runtime/session/session-recovery';

const AUTHORITY = {
  roomId: '019cebf0-79b8-7a22-8000-000000000001',
  seatIndex: 0,
  seatToken: '019cebf0-79b8-4a22-8000-000000000002',
} as RoomAuthority;

const REPLACEMENT_AUTHORITY = {
  roomId: '019cebf0-79b8-7a22-8000-000000000003',
  seatIndex: 1,
  seatToken: '019cebf0-79b8-4a22-8000-000000000004',
} as RoomAuthority;

const PLAYING_GAME = {
  stateVersion: 1,
  match: { status: 'playing' },
} as GameSnapshot;

const FINISHED_GAME = {
  stateVersion: 2,
  match: { status: 'finished' },
} as GameSnapshot;

afterEach(() => {
  vi.useRealTimers();
});

describe('Game recovery', () => {
  test.each(['dispose', 'replace'] as const)(
    'does not start stale synchronization after a publication observer wins with %s',
    async (action) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const session = createSessionFixture();
      const replacement = createSessionFixture({ connection: 'disconnected' });
      const sessions = createInstalledHolder(session.value, (authority) =>
        authority.roomId === AUTHORITY.roomId ? session.value : replacement.value,
      );
      const onUnexpected = vi.fn();
      const recovery = createSessionRecovery({ sessions, now: Date.now, onUnexpected });
      const attempts = vi.fn();
      recovery.subscribeAttempt(attempts);
      recovery.start();
      let changed = false;
      recovery.subscribe(() => {
        if (changed || recovery.getSnapshot().status !== 'synchronizing') return;
        changed = true;
        if (action === 'dispose') recovery.dispose();
        else sessions.installAuthority(REPLACEMENT_AUTHORITY);
      });

      recovery.requestSynchronization();
      await Promise.resolve();

      expect(session.value.synchronize).not.toHaveBeenCalled();
      expect(replacement.value.synchronize).not.toHaveBeenCalled();
      expect(onUnexpected).not.toHaveBeenCalled();
      expect(attempts.mock.calls.slice(0, 2)).toEqual([
        [{ phase: 'started' }],
        [{ phase: 'finished', outcome: 'cancelled', durationMs: 0 }],
      ]);
      if (action === 'replace') {
        expect(recovery.getSnapshot()).toEqual({ status: 'reconnecting' });
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(replacement.value.disconnect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(recovery.getSnapshot()).toEqual({ status: 'refreshRequired', error: null });
        expect(replacement.value.disconnect).toHaveBeenCalledOnce();
      } else expect(vi.getTimerCount()).toBe(0);
      recovery.dispose();
      sessions.dispose();
    },
  );

  test('confirms a timed-out incident after live state clears the failure without a new revision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture({ syncRevision: 1 });
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
    });
    const attempts = vi.fn();
    recovery.subscribeAttempt(attempts);
    recovery.start();
    session.publish({ syncStatus: 'synchronizing' });
    session.publish({
      syncStatus: 'idle',
      error: { kind: 'transport', code: CLIENT_ERROR_CODE.ACK_TIMEOUT },
    });
    session.publish({
      error: null,
      game: { ...PLAYING_GAME, stateVersion: FINISHED_GAME.stateVersion },
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(session.value.synchronize).not.toHaveBeenCalled();
    expect(recovery.getSnapshot().status).toBe('synchronizing');
    await vi.advanceTimersByTimeAsync(1);

    expect(session.value.synchronize).toHaveBeenCalledTimes(1);
    expect(session.value.getSnapshot().syncRevision).toBe(2);
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
    expect(attempts.mock.calls).toEqual([
      [{ phase: 'started' }],
      [{ phase: 'finished', outcome: 'success', durationMs: 1_000 }],
    ]);
    recovery.dispose();
  });

  test('honors rate-limit backoff after live clears its error and foreground repeats', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture();
    const foreground = createForegroundFixture();
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
      subscribeForeground: foreground.subscribe,
    });
    recovery.start();
    session.publish({
      error: {
        kind: 'server',
        error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: 4_000 } },
      },
    });
    session.publish({ error: null });
    foreground.publish();
    foreground.publish();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(session.value.synchronize).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.value.synchronize).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot().status).toBe('idle');
    recovery.dispose();
  });

  test('leaves an active or disconnected SDK sync to its owner', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture();
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
    });
    recovery.start();
    session.publish({ error: { kind: 'transport', code: CLIENT_ERROR_CODE.ACK_TIMEOUT } });
    await vi.advanceTimersByTimeAsync(500);
    session.publish({ syncStatus: 'synchronizing' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.value.synchronize).not.toHaveBeenCalled();
    session.publish({ syncStatus: 'idle', connection: 'disconnected' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.value.synchronize).not.toHaveBeenCalled();
    session.publish({ connection: 'connected' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.value.synchronize).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot().status).toBe('idle');
    recovery.dispose();
  });

  test('does not start a new foreground incident for healthy authenticated waiting', () => {
    const session = createSessionFixture({
      game: null,
      room: { status: 'waiting' } as NonNullable<GameSessionSnapshot['room']>,
      syncRevision: 1,
    });
    const foreground = createForegroundFixture();
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      subscribeForeground: foreground.subscribe,
    });
    recovery.start();
    foreground.publish();
    expect(session.value.synchronize).not.toHaveBeenCalled();
    expect(recovery.getSnapshot().status).toBe('idle');
    recovery.dispose();
  });

  test('reconfirms authenticated waiting after its initial confirmation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture({
      game: null,
      room: { status: 'waiting' } as NonNullable<GameSessionSnapshot['room']>,
      syncRevision: 1,
      error: { kind: 'transport', code: CLIENT_ERROR_CODE.ACK_TIMEOUT },
    });
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
    });
    recovery.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.value.synchronize).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot().status).toBe('idle');
    recovery.dispose();
  });

  test('keeps ok without a new revision locked and bounded by the original deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture({ connection: 'disconnected' });
    vi.mocked(session.value.synchronize).mockResolvedValue({ ok: true });
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
    });
    recovery.start();
    await vi.advanceTimersByTimeAsync(28_000);
    session.publish({ connection: 'connected' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.value.synchronize).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot().status).toBe('synchronizing');
    await vi.advanceTimersByTimeAsync(999);
    expect(session.value.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.value.synchronize).toHaveBeenCalledTimes(1);
    expect(session.value.disconnect).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot().status).toBe('refreshRequired');
    recovery.dispose();
  });

  test.each([29_999, 30_000])(
    'accepts a fresh playing confirmation only before the incident deadline (%s ms)',
    (confirmedAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const session = createSessionFixture({ connection: 'disconnected' });
      const recovery = createSessionRecovery({
        sessions: createInstalledHolder(session.value),
        now: Date.now,
      });
      recovery.start();
      // Delivery can precede a delayed expiry timer; the incident still owns its absolute cutoff.
      vi.setSystemTime(confirmedAt);
      session.publish({ connection: 'connected', syncRevision: 1 });
      expect(recovery.getSnapshot().status).toBe(confirmedAt < 30_000 ? 'idle' : 'refreshRequired');
      expect(session.value.disconnect).toHaveBeenCalledTimes(confirmedAt < 30_000 ? 0 : 1);
      recovery.dispose();
    },
  );

  test.each(['replaced', 'cleared', 'disposed', 'finished', 'terminal'] as const)(
    'invalidates cancelled automatic confirmation callbacks after %s',
    async (state) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const session = createSessionFixture();
      const replacement = createSessionFixture();
      const sessions = createInstalledHolder(session.value, (authority) =>
        authority.roomId === AUTHORITY.roomId ? session.value : replacement.value,
      );
      const callbacks: (() => void)[] = [];
      const recovery = createSessionRecovery({
        sessions,
        now: Date.now,
        setTimeout: (callback, delay) => {
          callbacks.push(callback);
          return globalThis.setTimeout(callback, delay);
        },
      });
      const attempts = vi.fn();
      recovery.subscribeAttempt(attempts);
      recovery.start();
      session.publish({ error: { kind: 'transport', code: CLIENT_ERROR_CODE.ACK_TIMEOUT } });
      expect(callbacks).toHaveLength(2);
      if (state === 'replaced') sessions.installAuthority(REPLACEMENT_AUTHORITY);
      if (state === 'cleared') sessions.clear();
      if (state === 'disposed') recovery.dispose();
      if (state === 'finished') session.publish({ game: FINISHED_GAME });
      if (state === 'terminal')
        session.publish({ error: serverError(PUBLIC_ERROR_CODE.ROOM_NOT_FOUND) });
      const finalAttempts = attempts.mock.calls.length;
      callbacks[1]!();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(session.value.synchronize).not.toHaveBeenCalled();
      expect(replacement.value.synchronize).not.toHaveBeenCalled();
      expect(attempts.mock.calls).toHaveLength(finalAttempts);
      recovery.dispose();
    },
  );

  test('retains refresh-only after a failed parity confirmation is automatically retried', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture();
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
    });
    recovery.start();
    vi.mocked(session.value.synchronize).mockImplementationOnce(async () => {
      const error: ClientError = { kind: 'transport', code: CLIENT_ERROR_CODE.ACK_TIMEOUT };
      session.publish({ syncStatus: 'idle', error });
      return { ok: false, error };
    });
    recovery.requireRefreshAfterSynchronization();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.value.synchronize).toHaveBeenCalledTimes(2);
    expect(session.value.disconnect).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot()).toEqual({ status: 'refreshRequired', error: null });
    recovery.dispose();
  });

  test.each(['active', 'replaced', 'disposed', 'finished'] as const)(
    'reports an unexpected synchronization rejection only for an active owner (%s)',
    async (state) => {
      const session = createSessionFixture();
      const replacement = createSessionFixture();
      const sessions = createInstalledHolder(session.value, (authority) =>
        authority.roomId === AUTHORITY.roomId ? session.value : replacement.value,
      );
      let rejectSynchronization!: (cause: unknown) => void;
      vi.mocked(session.value.synchronize).mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectSynchronization = reject;
        }),
      );
      const onUnexpected = vi.fn();
      const recovery = createSessionRecovery({ sessions, onUnexpected });
      recovery.start();
      recovery.requestSynchronization();
      if (state === 'replaced') sessions.installAuthority(REPLACEMENT_AUTHORITY);
      if (state === 'disposed') recovery.dispose();
      if (state === 'finished') session.publish({ game: FINISHED_GAME });
      const cause = new TypeError('synchronization invariant');
      rejectSynchronization(cause);
      await Promise.resolve();
      expect(onUnexpected.mock.calls).toEqual(state === 'active' ? [[cause]] : []);
      if (state === 'active') expect(recovery.getSnapshot().status).toBe('synchronizing');
      recovery.dispose();
      sessions.dispose();
    },
  );
  test('reports owner-confirmed success and closes a later active episode once on dispose', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture();
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
    });
    const attempt = vi.fn();
    recovery.subscribeAttempt(attempt);
    recovery.start();
    session.publish({ connection: 'disconnected' });
    vi.advanceTimersByTime(20);
    session.publish({ connection: 'connected' });
    expect(attempt.mock.calls.map(([event]) => event)).toEqual([{ phase: 'started' }]);
    vi.advanceTimersByTime(30);
    session.publish({ syncRevision: 1 });
    session.publish({ syncRevision: 1 });
    session.publish({ connection: 'disconnected' });
    vi.advanceTimersByTime(10);
    recovery.dispose();
    recovery.dispose();
    session.publish({ connection: 'connected', syncRevision: 2 });
    vi.advanceTimersByTime(30_000);
    expect(attempt.mock.calls.map(([event]) => event)).toEqual([
      { phase: 'started' },
      { phase: 'finished', outcome: 'success', durationMs: 50 },
      { phase: 'started' },
      { phase: 'finished', outcome: 'cancelled', durationMs: 10 },
    ]);
    expect(session.value.disconnect).not.toHaveBeenCalled();
  });

  test('bounds authenticated waiting-room recovery without resetting on reconnect', () => {
    vi.useFakeTimers();
    const session = createSessionFixture({
      game: null,
      room: { status: 'waiting' } as NonNullable<GameSessionSnapshot['room']>,
      syncRevision: 1,
    });
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
    });
    const attempt = vi.fn();
    recovery.subscribeAttempt(attempt);
    recovery.start();
    session.publish({ connection: 'disconnected' });
    expect(recovery.getSnapshot()).toEqual({ status: 'reconnecting' });
    vi.advanceTimersByTime(20_000);
    session.publish({ connection: 'connected', syncStatus: 'synchronizing' });
    expect(recovery.getSnapshot()).toEqual({ status: 'synchronizing' });
    vi.advanceTimersByTime(10_000);
    expect(recovery.getSnapshot()).toEqual({ status: 'refreshRequired', error: null });
    expect(session.value.disconnect).toHaveBeenCalledOnce();
    expect(attempt.mock.calls.map(([event]) => event)).toEqual([
      { phase: 'started' },
      { phase: 'finished', outcome: 'failure', durationMs: 30_000 },
    ]);
    session.publish({ syncStatus: 'idle', syncRevision: 2 });
    expect(recovery.getSnapshot().status).toBe('refreshRequired');
    recovery.dispose();
  });

  test('restores waiting only after a fresh full sync and yields to a started game', () => {
    vi.useFakeTimers();
    const session = createSessionFixture({
      game: null,
      room: { status: 'waiting' } as NonNullable<GameSessionSnapshot['room']>,
      syncRevision: 1,
    });
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
    });
    recovery.start();
    session.publish({ connection: 'disconnected' });
    session.publish({ connection: 'connected', syncStatus: 'idle' });
    expect(recovery.getSnapshot().status).toBe('synchronizing');
    session.publish({ syncRevision: 2 });
    expect(recovery.getSnapshot().status).toBe('idle');
    session.publish({ connection: 'disconnected' });
    session.publish({ connection: 'connected', game: PLAYING_GAME, syncRevision: 3 });
    expect(recovery.getSnapshot().status).toBe('idle');
    vi.advanceTimersByTime(30_000);
    expect(session.value.disconnect).not.toHaveBeenCalled();
    recovery.dispose();
  });

  test('leaves pre-authentication waiting state to the admission/reentry owner', () => {
    const session = createSessionFixture({ game: null, room: null, connection: 'disconnected' });
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    recovery.start();
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
    recovery.dispose();
  });

  test('keeps recovery active until the authenticated connection publishes a newer full sync', () => {
    const session = createSessionFixture();
    const sessions = createGameSessionHolder({
      createSession: vi.fn(() => session.value),
    } as Pick<GameClient, 'createSession'>);
    sessions.installAuthority(AUTHORITY);
    const recovery = createSessionRecovery({ sessions });

    recovery.start();
    session.publish({ connection: 'disconnected' });
    expect(recovery.getSnapshot()).toEqual({ status: 'reconnecting' });

    session.publish({ connection: 'connected', syncStatus: 'synchronizing' });
    expect(recovery.getSnapshot()).toEqual({ status: 'synchronizing' });
    expect(session.value.synchronize).not.toHaveBeenCalled();

    session.publish({ syncStatus: 'idle' });
    expect(recovery.getSnapshot()).toEqual({ status: 'synchronizing' });

    session.publish({ syncRevision: 1 });
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
  });

  test('cancels recovery when a newer full sync finishes the match', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture();
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    recovery.start();
    session.publish({ connection: 'disconnected' });
    expect(recovery.getSnapshot()).toEqual({ status: 'reconnecting' });

    session.publish({
      connection: 'connected',
      syncStatus: 'idle',
      syncRevision: 1,
      game: FINISHED_GAME,
      error: null,
    });
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });

    vi.advanceTimersByTime(30_001);
    expect(session.value.disconnect).not.toHaveBeenCalled();
  });

  test('requests one full sync on foreground return and waits for its revision', () => {
    const session = createSessionFixture();
    const sessions = createInstalledHolder(session.value);
    const foreground = createForegroundFixture();
    const recovery = createSessionRecovery({
      sessions,
      subscribeForeground: foreground.subscribe,
    });
    recovery.start();

    foreground.publish();

    expect(session.value.synchronize).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot()).toEqual({ status: 'synchronizing' });

    session.publish({ syncStatus: 'synchronizing' });
    session.publish({ syncStatus: 'idle', syncRevision: 1 });
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
  });

  test('requests the same full-sync recovery when a global guard releases', () => {
    const session = createSessionFixture();
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    recovery.start();

    recovery.requestSynchronization();

    expect(session.value.synchronize).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot()).toEqual({ status: 'synchronizing' });

    session.publish({ syncStatus: 'synchronizing' });
    session.publish({ syncStatus: 'idle', syncRevision: 1 });
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
  });

  test('preserves parity refresh when another sync request joins the same incident', () => {
    const session = createSessionFixture();
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    recovery.start();

    recovery.requireRefreshAfterSynchronization();

    expect(session.value.synchronize).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot()).toEqual({ status: 'synchronizing' });

    recovery.requestSynchronization();
    session.publish({ syncStatus: 'synchronizing' });
    session.publish({ syncStatus: 'idle', syncRevision: 1 });
    expect(session.value.disconnect).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot()).toEqual({ status: 'refreshRequired', error: null });
  });

  test('preserves an authoritative Result reached by the parity full sync', () => {
    const session = createSessionFixture();
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    recovery.start();

    recovery.requireRefreshAfterSynchronization();
    session.publish({ syncStatus: 'synchronizing' });
    session.publish({ game: FINISHED_GAME, syncStatus: 'idle', syncRevision: 1 });

    expect(session.value.disconnect).not.toHaveBeenCalled();
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
  });

  test('does not request foreground sync while the SDK is disconnected', () => {
    const session = createSessionFixture({ connection: 'disconnected' });
    const foreground = createForegroundFixture();
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      subscribeForeground: foreground.subscribe,
    });
    recovery.start();

    foreground.publish();

    expect(session.value.synchronize).not.toHaveBeenCalled();
    expect(recovery.getSnapshot()).toEqual({ status: 'reconnecting' });
  });

  test('waits for SDK reconnect instead of synchronizing a disconnected guard exit', () => {
    const session = createSessionFixture({ connection: 'disconnected' });
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    recovery.start();

    recovery.requestSynchronization();

    expect(session.value.synchronize).not.toHaveBeenCalled();
    expect(recovery.getSnapshot()).toEqual({ status: 'reconnecting' });
  });

  test('does not reset the 30 second budget when the same incident changes phase', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture();
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    recovery.start();

    session.publish({ connection: 'disconnected' });
    vi.advanceTimersByTime(20_000);
    session.publish({ connection: 'connected', syncStatus: 'synchronizing' });
    vi.advanceTimersByTime(9_999);
    expect(recovery.getSnapshot()).toEqual({ status: 'synchronizing' });

    vi.advanceTimersByTime(1);
    expect(session.value.disconnect).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot()).toEqual({ status: 'refreshRequired', error: null });
  });

  test('invalidates late session and foreground callbacks after the incident budget expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture();
    const foreground = createForegroundFixture();
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      subscribeForeground: foreground.subscribe,
    });
    recovery.start();
    session.publish({ connection: 'disconnected' });

    vi.advanceTimersByTime(30_000);
    session.publish({ connection: 'disconnected' });
    foreground.publish();
    vi.advanceTimersByTime(30_000);

    expect(recovery.getSnapshot()).toEqual({ status: 'refreshRequired', error: null });
    expect(session.value.disconnect).toHaveBeenCalledTimes(1);
    expect(session.value.synchronize).not.toHaveBeenCalled();
  });

  test('preserves the current SDK failure when the incident budget expires', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const error: ClientError = {
      kind: 'transport',
      code: CLIENT_ERROR_CODE.ACK_TIMEOUT,
    };
    const session = createSessionFixture({ error });
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    recovery.start();

    vi.advanceTimersByTime(30_000);

    expect(recovery.getSnapshot()).toEqual({ status: 'refreshRequired', error });
  });

  test.each([
    PUBLIC_ERROR_CODE.ROOM_NOT_FOUND,
    PUBLIC_ERROR_CODE.INVALID_AUTHORITY,
    PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE,
  ])('ends immediately for permanent authority error %s', (code) => {
    const session = createSessionFixture();
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    const error = serverError(code);
    recovery.start();

    session.publish({ error });

    expect(session.value.disconnect).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot()).toEqual({ status: 'permanentFailure', error });
  });

  test.each([
    CLIENT_ERROR_CODE.PROTOCOL_MISMATCH,
    CLIENT_ERROR_CODE.STATE_UNAVAILABLE,
    CLIENT_ERROR_CODE.INVALID_RESPONSE,
  ])('requires refresh immediately for %s', (code) => {
    const session = createSessionFixture();
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    const error: ClientError = {
      kind: 'protocol',
      code,
    };
    recovery.start();

    recovery.reportCommandError(error);

    expect(session.value.disconnect).toHaveBeenCalledTimes(1);
    expect(recovery.getSnapshot()).toEqual({ status: 'refreshRequired', error });
  });

  test('ignores confirmed ordinary command rejections', () => {
    const session = createSessionFixture();
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    recovery.start();

    recovery.reportCommandError(serverError(PUBLIC_ERROR_CODE.NOT_YOUR_TURN));

    expect(session.value.disconnect).not.toHaveBeenCalled();
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
  });

  test('ignores an acknowledgement timeout after SDK full-sync recovery is already clean', () => {
    const session = createSessionFixture({ syncRevision: 1 });
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    recovery.start();

    recovery.reportCommandError({
      kind: 'transport',
      code: CLIENT_ERROR_CODE.ACK_TIMEOUT,
    });

    expect(session.value.synchronize).not.toHaveBeenCalled();
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
  });

  test('uses the current failed SDK snapshot when acknowledgement recovery did not succeed', () => {
    const error: ClientError = {
      kind: 'transport',
      code: CLIENT_ERROR_CODE.ACK_TIMEOUT,
    };
    const session = createSessionFixture({ error });
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    recovery.start();

    recovery.reportCommandError(error);

    expect(session.value.synchronize).not.toHaveBeenCalled();
    expect(recovery.getSnapshot()).toEqual({ status: 'synchronizing' });
  });

  test.each([
    ['waiting', null],
    ['finished', FINISHED_GAME],
  ] as const)('does not recover a %s lifecycle', (_name, game) => {
    const session = createSessionFixture({ game, connection: 'disconnected' });
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });

    recovery.start();
    recovery.requestSynchronization();
    recovery.requireRefreshAfterSynchronization();

    expect(session.value.synchronize).not.toHaveBeenCalled();
    expect(session.value.disconnect).not.toHaveBeenCalled();
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
  });

  test('resets a terminal incident when the holder installs a replacement authority', () => {
    const first = createSessionFixture();
    const replacement = createSessionFixture();
    const sessions = createInstalledHolder(first.value, (authority) =>
      authority.roomId === AUTHORITY.roomId ? first.value : replacement.value,
    );
    const recovery = createSessionRecovery({ sessions });
    recovery.start();
    first.publish({ error: serverError(PUBLIC_ERROR_CODE.ROOM_NOT_FOUND) });
    expect(recovery.getSnapshot().status).toBe('permanentFailure');

    sessions.installAuthority(REPLACEMENT_AUTHORITY);

    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
  });

  test('clears an active incident when the holder is cleared', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture();
    const sessions = createInstalledHolder(session.value);
    const recovery = createSessionRecovery({
      sessions,
      now: Date.now,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    recovery.start();
    session.publish({ connection: 'disconnected' });

    sessions.clear();
    vi.advanceTimersByTime(30_000);

    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
    expect(session.value.disconnect).not.toHaveBeenCalled();
  });

  test('dispose cancels subscriptions and an active incident without disconnecting authority', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const session = createSessionFixture();
    const foreground = createForegroundFixture();
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      subscribeForeground: foreground.subscribe,
    });
    recovery.start();
    recovery.start();
    expect(foreground.listenerCount()).toBe(1);
    session.publish({ connection: 'disconnected' });

    recovery.dispose();
    vi.advanceTimersByTime(30_000);
    foreground.publish();

    expect(foreground.listenerCount()).toBe(0);
    expect(session.value.disconnect).not.toHaveBeenCalled();
    expect(session.value.synchronize).not.toHaveBeenCalled();
  });

  test('ignores a pending foreground synchronization callback after dispose', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const synchronization = deferred<Awaited<ReturnType<GameSession['synchronize']>>>();
    const session = createSessionFixture();
    vi.mocked(session.value.synchronize).mockReturnValueOnce(synchronization.promise);
    const foreground = createForegroundFixture();
    const schedule = vi.fn(globalThis.setTimeout);
    const recovery = createSessionRecovery({
      sessions: createInstalledHolder(session.value),
      now: Date.now,
      setTimeout: schedule,
      clearTimeout: globalThis.clearTimeout,
      subscribeForeground: foreground.subscribe,
    });
    recovery.start();
    foreground.publish();
    recovery.dispose();
    session.publish({ syncStatus: 'synchronizing' });

    synchronization.resolve({ ok: true });
    await synchronization.promise;
    await Promise.resolve();
    vi.advanceTimersByTime(30_000);

    expect(session.value.disconnect).not.toHaveBeenCalled();
    expect(recovery.getSnapshot()).toEqual({ status: 'synchronizing' });
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('ends an active incident when its SDK session is explicitly disposed', () => {
    const session = createSessionFixture({ connection: 'disconnected' });
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    recovery.start();
    expect(recovery.getSnapshot()).toEqual({ status: 'reconnecting' });

    session.publish({ connection: 'disposed', syncStatus: 'idle', error: null });

    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
  });

  test('ignores command errors after dispose', () => {
    const session = createSessionFixture();
    const recovery = createSessionRecovery({ sessions: createInstalledHolder(session.value) });
    recovery.start();
    recovery.dispose();

    recovery.reportCommandError({
      kind: 'protocol',
      code: CLIENT_ERROR_CODE.PROTOCOL_MISMATCH,
    });
    recovery.requestSynchronization();
    recovery.requireRefreshAfterSynchronization();

    expect(session.value.disconnect).not.toHaveBeenCalled();
    expect(session.value.synchronize).not.toHaveBeenCalled();
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
  });
});

function createInstalledHolder(
  session: GameSession,
  createSession: (authority: RoomAuthority) => GameSession = () => session,
) {
  const sessions = createGameSessionHolder({
    createSession: vi.fn(createSession),
  } as Pick<GameClient, 'createSession'>);
  sessions.installAuthority(AUTHORITY);
  return sessions;
}

function createForegroundFixture() {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish() {
      listeners.forEach((listener) => listener());
    },
    listenerCount: () => listeners.size,
  };
}

function createSessionFixture(initial: Partial<GameSessionSnapshot> = {}) {
  let snapshot: GameSessionSnapshot = {
    connection: 'connected',
    syncStatus: 'idle',
    syncRevision: 0,
    room: null,
    game: PLAYING_GAME,
    presence: null,
    presentation: null,
    error: null,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const unavailable = () => Promise.resolve({ ok: false as const, error: {} as never });
  const value: GameSession = {
    connect: vi.fn(unavailable),
    disconnect: vi.fn(),
    dispose: vi.fn(),
    synchronize: vi.fn(async () => {
      snapshot = { ...snapshot, syncStatus: 'synchronizing' };
      listeners.forEach((listener) => listener());
      await Promise.resolve();
      snapshot = {
        ...snapshot,
        syncStatus: 'idle',
        syncRevision: snapshot.syncRevision + 1,
        error: null,
      };
      listeners.forEach((listener) => listener());
      return { ok: true as const };
    }),
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
    publish(next: Partial<GameSessionSnapshot>) {
      snapshot = { ...snapshot, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}

function serverError(
  code: (typeof PUBLIC_ERROR_CODE)[keyof typeof PUBLIC_ERROR_CODE],
): ClientError {
  return {
    kind: 'server',
    error: { code, params: {} } as never,
  };
}

function deferred<T>() {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}
