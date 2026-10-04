import type { GameSession, GameSessionSnapshot } from '@repo/game-client-sdk';
import { expect, it, vi } from 'vitest';

import type { StoredRoomRestore } from '@/runtime/room-access/stored-room-restore';
import type { RecoveryAttemptEvent } from '@/runtime/session/recovery-attempt';
import { createGameSessionHolder } from '@/runtime/session/session-holder';
import { createSessionRecovery, type SessionRecovery } from '@/runtime/session/session-recovery';
import { observeTelemetry } from '@/runtime/telemetry/observe-telemetry';
import { inactiveTelemetry } from '@/runtime/telemetry/telemetry';
import { authority, finishedGame, playingGame } from '@/testing/game-fixtures';

it('records cancellation when live finished arrives before the pending full sync completes', () => {
  let time = 100;
  const fixture = recoveryFixture();
  const recovery = createSessionRecovery({
    sessions: fixture.sessions,
    now: () => time,
    subscribeForeground: () => () => {},
  });
  const event = vi.fn();
  const stop = observeTelemetry({
    telemetry: { ...inactiveTelemetry, trackEvent: event },
    sessions: fixture.sessions,
    recovery,
    restore: idleReentry(),
  });
  recovery.start();
  fixture.publish({ connection: 'disconnected' });
  time = 300;
  fixture.publish({ connection: 'connected', syncStatus: 'synchronizing' });
  fixture.publish({ game: finishedGame('explicitForfeit', 0) });
  fixture.publish({ syncStatus: 'idle', syncRevision: 2 });
  recovery.dispose();
  stop();
  fixture.sessions.dispose();
  expect(
    event.mock.calls.map(([value]) => value).filter((value) => value.name.startsWith('recovery_')),
  ).toEqual([
    { name: 'recovery_started', operation: 'connection' },
    { name: 'recovery_result', operation: 'connection', outcome: 'cancelled', duration_ms: 200 },
  ]);
});

function idleReentry(): StoredRoomRestore {
  return {
    getSnapshot: () => ({ status: 'idle' }),
    subscribe: () => () => {},
    subscribeAttempt: () => () => {},
    check() {},
    dispose() {},
    completeHandoff() {},
    confirmPermanentFailure() {},
  };
}

function recoveryFixture() {
  let snapshot: GameSessionSnapshot = {
    connection: 'connected',
    syncStatus: 'idle',
    syncRevision: 1,
    game: playingGame,
    room: null,
    presence: null,
    presentation: null,
    error: null,
  };
  const listeners = new Set<() => void>();
  const unused = vi.fn(async () => {
    throw Error('unused');
  });
  const session: GameSession = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect: unused,
    disconnect: vi.fn(),
    dispose: vi.fn(),
    synchronize: unused,
    rollDice: unused,
    setDieHeld: unused,
    selectScoreCategory: unused,
    forfeitMatch: unused,
  };
  const sessions = createGameSessionHolder({ createSession: () => session });
  sessions.installAuthority(authority);
  return {
    sessions,
    publish(next: Partial<GameSessionSnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
  };
}

it.each(['new', 'resumed'] as const)(
  'preserves %s participation through handoff, duplicate sync and disconnect snapshots',
  (entry) => {
    let snapshot: GameSessionSnapshot = {
      connection: 'connected',
      syncStatus: 'idle',
      syncRevision: 1,
      game: null,
      room: null,
      presence: null,
      presentation: null,
      error: null,
    };
    let publish = () => {};
    const unused = vi.fn(async () => {
      throw Error('unused');
    });
    const session: GameSession = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        publish = listener;
        return () => {};
      },
      connect: unused,
      disconnect() {},
      dispose() {},
      synchronize: unused,
      rollDice: unused,
      setDieHeld: unused,
      selectScoreCategory: unused,
      forfeitMatch: unused,
    };
    const sessions = createGameSessionHolder({ createSession: () => session });
    const recovery: SessionRecovery = {
      getSnapshot: () => ({ status: 'idle' }),
      subscribe: () => () => {},
      subscribeAttempt: () => () => {},
      start() {},
      dispose() {},
      requestSynchronization() {},
      requireRefreshAfterSynchronization() {},
      reportCommandError() {},
    };
    let reentrySnapshot: ReturnType<StoredRoomRestore['getSnapshot']> =
      entry === 'new' ? { status: 'idle' } : { status: 'checking' };
    const reentry: StoredRoomRestore = {
      getSnapshot: () => reentrySnapshot,
      subscribe: () => () => {},
      subscribeAttempt: () => () => {},
      check() {},
      dispose() {},
      completeHandoff() {},
      confirmPermanentFailure() {},
    };
    const event = vi.fn();
    const stop = observeTelemetry({
      telemetry: { ...inactiveTelemetry, trackEvent: event },
      sessions,
      recovery,
      restore: reentry,
    });
    sessions.installAuthority(authority);
    snapshot = { ...snapshot, game: playingGame };
    publish();
    publish();
    snapshot = { ...snapshot, connection: 'disconnected' };
    publish();
    reentrySnapshot = { status: 'idle' };
    snapshot = { ...snapshot, connection: 'connected', syncRevision: 2 };
    publish();
    snapshot = { ...snapshot, game: finishedGame('explicitForfeit', 0) };
    publish();
    publish();
    expect(event.mock.calls.map(([value]) => value)).toEqual([
      { name: 'play_started', entry },
      { name: 'play_finished', entry, reason: 'forfeit', outcome: 'win' },
    ]);
    expect(JSON.stringify(event.mock.calls)).not.toContain(authority.roomId);
    stop();
    sessions.dispose();
  },
);

it('counts and diagnoses failed reentry once even after a later snapshot changes', () => {
  let recoverySnapshot: ReturnType<SessionRecovery['getSnapshot']> = { status: 'idle' };
  let reentrySnapshot: ReturnType<StoredRoomRestore['getSnapshot']> = { status: 'idle' };
  let publishRecovery = () => {};
  let publishAttempt = (_event: RecoveryAttemptEvent) => {};
  const recovery: SessionRecovery = {
    getSnapshot: () => recoverySnapshot,
    subscribe(listener: () => void) {
      publishRecovery = listener;
      return () => {};
    },
    subscribeAttempt: () => () => {},
    start() {},
    dispose() {},
    requestSynchronization() {},
    requireRefreshAfterSynchronization() {},
    reportCommandError() {},
  };
  const reentry: StoredRoomRestore = {
    getSnapshot: () => reentrySnapshot,
    subscribe: () => () => {},
    subscribeAttempt(listener: (event: RecoveryAttemptEvent) => void) {
      publishAttempt = listener;
      return () => {};
    },
    check() {},
    dispose() {},
    completeHandoff() {},
    confirmPermanentFailure() {},
  };
  const sessions = createGameSessionHolder({
    createSession: () => {
      throw Error('unused');
    },
  });
  const event = vi.fn();
  const reportUnexpected = vi.fn();
  const stop = observeTelemetry({
    telemetry: { ...inactiveTelemetry, trackEvent: event, reportUnexpected },
    sessions,
    recovery,
    restore: reentry,
  });
  reentrySnapshot = { status: 'checking' };
  publishAttempt({ phase: 'started' });
  recoverySnapshot = { status: 'synchronizing' };
  publishRecovery();
  recoverySnapshot = { status: 'refreshRequired', error: null };
  publishRecovery();
  reentrySnapshot = { status: 'refreshRequired', error: null };
  publishAttempt({
    phase: 'finished',
    outcome: 'failure',
    durationMs: 0,
    error: { kind: 'protocol', code: 'INVALID_RESPONSE' },
  });
  publishAttempt({
    phase: 'finished',
    outcome: 'failure',
    durationMs: 0,
    error: { kind: 'protocol', code: 'INVALID_RESPONSE' },
  });
  expect(event.mock.calls.map(([value]) => value)).toEqual([
    { name: 'recovery_started', operation: 'reentry' },
    {
      name: 'recovery_result',
      operation: 'reentry',
      outcome: 'failure',
      duration_ms: 0,
      failure_kind: 'protocol',
      failure_code: 'INVALID_RESPONSE',
    },
  ]);
  expect(reportUnexpected.mock.calls).toEqual([
    [
      expect.objectContaining({ message: 'INVALID_RESPONSE' }),
      { operation: 'synchronize', stage: 'response', error_code: 'INVALID_RESPONSE' },
    ],
  ]);
  stop();
  sessions.dispose();
});

it('diagnoses each session error once without losing the first playing event after an error', () => {
  const fixture = recoveryFixture();
  fixture.publish({ game: null });
  const recovery = createSessionRecovery({ sessions: fixture.sessions });
  const reportUnexpected = vi.fn();
  const trackEvent = vi.fn();
  const stop = observeTelemetry({
    telemetry: { ...inactiveTelemetry, reportUnexpected, trackEvent },
    sessions: fixture.sessions,
    recovery,
    restore: idleReentry(),
  });
  const error = { kind: 'protocol', code: 'INVALID_RESPONSE', requestId: 'PRIVATE' } as const;
  fixture.publish({ error });
  fixture.publish({ syncStatus: 'synchronizing' });
  fixture.publish({ syncStatus: 'idle', game: playingGame, error: null });
  fixture.publish({ game: playingGame });
  expect(reportUnexpected).toHaveBeenCalledOnce();
  expect(trackEvent).toHaveBeenCalledExactlyOnceWith({ name: 'play_started', entry: 'new' });
  fixture.publish({ error: { ...error } });
  expect(reportUnexpected).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(reportUnexpected.mock.calls)).not.toContain('PRIVATE');
  stop();
  recovery.dispose();
  fixture.sessions.dispose();
});

it('does not count a finished baseline as a new participation', () => {
  const fixture = recoveryFixture();
  fixture.publish({ game: finishedGame('scoresCompleted', 0) });
  const recovery = createSessionRecovery({ sessions: fixture.sessions });
  const trackEvent = vi.fn();
  const stop = observeTelemetry({
    telemetry: { ...inactiveTelemetry, trackEvent },
    sessions: fixture.sessions,
    recovery,
    restore: idleReentry(),
  });
  fixture.publish({ syncRevision: 2 });
  expect(trackEvent).not.toHaveBeenCalled();
  stop();
  recovery.dispose();
  fixture.sessions.dispose();
});

it('counts one reentry pair while its owner includes the lower connection recovery', () => {
  const fixture = recoveryFixture();
  const recovery = createSessionRecovery({
    sessions: fixture.sessions,
    subscribeForeground: () => () => {},
  });
  let attempt = (_event: RecoveryAttemptEvent) => {};
  const reentry: StoredRoomRestore = {
    ...idleReentry(),
    getSnapshot: () => ({ status: 'checking' }),
    subscribeAttempt(listener: (event: RecoveryAttemptEvent) => void) {
      attempt = listener;
      return () => {};
    },
  };
  const trackEvent = vi.fn();
  const stop = observeTelemetry({
    telemetry: { ...inactiveTelemetry, trackEvent },
    sessions: fixture.sessions,
    recovery,
    restore: reentry,
  });
  recovery.start();
  attempt({ phase: 'started' });
  fixture.publish({ connection: 'disconnected' });
  fixture.publish({ connection: 'connected', syncRevision: 2 });
  attempt({ phase: 'finished', outcome: 'success', durationMs: 20 });
  expect(
    trackEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.name.startsWith('recovery_')),
  ).toEqual([
    { name: 'recovery_started', operation: 'reentry' },
    { name: 'recovery_result', operation: 'reentry', outcome: 'success', duration_ms: 20 },
  ]);
  stop();
  recovery.dispose();
  fixture.sessions.dispose();
});

it('keeps a reentry error under the attempt owner across failure and handoff snapshots', () => {
  const fixture = recoveryFixture();
  const recovery = createSessionRecovery({ sessions: fixture.sessions });
  let snapshot: ReturnType<StoredRoomRestore['getSnapshot']> = { status: 'checking' };
  let attempt = (_event: RecoveryAttemptEvent) => {};
  const reentry: StoredRoomRestore = {
    ...idleReentry(),
    getSnapshot: () => snapshot,
    subscribeAttempt(listener: (event: RecoveryAttemptEvent) => void) {
      attempt = listener;
      return () => {};
    },
  };
  const reportUnexpected = vi.fn();
  const stop = observeTelemetry({
    telemetry: { ...inactiveTelemetry, reportUnexpected },
    sessions: fixture.sessions,
    recovery,
    restore: reentry,
  });
  attempt({ phase: 'started' });
  const error = { kind: 'protocol', code: 'INVALID_RESPONSE' } as const;
  fixture.publish({ error });
  snapshot = { status: 'refreshRequired', error };
  attempt({ phase: 'finished', outcome: 'failure', durationMs: 10, error });
  fixture.publish({ syncRevision: 2 });
  snapshot = { status: 'idle' };
  fixture.publish({ syncRevision: 3 });
  expect(reportUnexpected).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
    operation: 'synchronize',
    stage: 'response',
    error_code: 'INVALID_RESPONSE',
  });
  stop();
  recovery.dispose();
  fixture.sessions.dispose();
});
