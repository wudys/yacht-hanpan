import type { ClientError } from '@repo/game-client-sdk/errors';
import { CLIENT_ERROR_CODE } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';

import { isPermanentAuthorityFailure } from '@/runtime/session/authority-failure';
import type { GameSessionHolder } from '@/runtime/session/game-session-holder';
import type { RecoveryAttemptEvent } from '@/runtime/session/recovery-attempt';

const SESSION_RECOVERY_BUDGET_MS = 30_000;
const CONFIRMATION_INTERVAL_MS = 1_000;

export type SessionRecoverySnapshot =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'reconnecting' }>
  | Readonly<{ status: 'synchronizing' }>
  | Readonly<{ status: 'permanentFailure'; error: ClientError }>
  | Readonly<{ status: 'refreshRequired'; error: ClientError | null }>;

export interface SessionRecovery {
  getSnapshot(): SessionRecoverySnapshot;
  subscribe(listener: () => void): () => void;
  subscribeAttempt(listener: (event: RecoveryAttemptEvent) => void): () => void;
  start(): void;
  dispose(): void;
  requestSynchronization(): void;
  requireRefreshAfterSynchronization(): void;
  reportCommandError(error: ClientError): void;
}

type TimerHandle = number | ReturnType<typeof setTimeout>;

type CreateSessionRecoveryOptions = Readonly<{
  sessions: GameSessionHolder;
  onUnexpected?: (error: unknown) => void;
  now?: () => number;
  setTimeout?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  subscribeForeground?: (listener: () => void) => () => void;
}>;

const IDLE: SessionRecoverySnapshot = { status: 'idle' };

export function createSessionRecovery(options: CreateSessionRecoveryOptions): SessionRecovery {
  const now = options.now ?? (() => globalThis.performance.now());
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const subscribeForeground = options.subscribeForeground ?? defaultSubscribeForeground;
  const subscribers = new Set<() => void>();
  const attemptSubscribers = new Set<(event: RecoveryAttemptEvent) => void>();
  let snapshot = IDLE;
  let started = false;
  let disposed = false;
  let unsubscribeSessions: (() => void) | null = null;
  let unsubscribeForeground: (() => void) | null = null;
  let incidentSession = null as ReturnType<GameSessionHolder['getSnapshot']>['session'];
  let terminalSession = null as typeof incidentSession;
  let incidentRevision = 0;
  let incidentDeadline = 0;
  let incidentGeneration = 0;
  let incidentTimer: TimerHandle | null = null;
  let confirmationTimer: TimerHandle | null = null;
  let confirmationNotBefore = 0;
  let rateLimitError: ClientError | null = null;
  let refreshAfterSynchronizationSession = null as typeof incidentSession;

  const publish = (next: SessionRecoverySnapshot): void => {
    if (
      snapshot.status === next.status &&
      (!('error' in snapshot) || ('error' in next && snapshot.error === next.error))
    ) {
      return;
    }
    snapshot = next;
    for (const subscriber of subscribers) subscriber();
  };

  const cancelConfirmation = (): void => {
    if (confirmationTimer !== null) cancel(confirmationTimer);
    confirmationTimer = null;
  };

  const releaseIncident = (
    outcome: 'success' | 'failure' | 'cancelled' = 'cancelled',
    error?: ClientError | null,
  ): void => {
    const active = incidentSession !== null;
    const durationMs = Math.max(0, now() - (incidentDeadline - SESSION_RECOVERY_BUDGET_MS));
    incidentGeneration += 1;
    cancelConfirmation();
    confirmationNotBefore = 0;
    rateLimitError = null;
    if (incidentTimer !== null) cancel(incidentTimer);
    incidentTimer = null;
    incidentSession = null;
    incidentDeadline = 0;
    refreshAfterSynchronizationSession = null;
    if (active) {
      for (const subscriber of attemptSubscribers) {
        subscriber({
          phase: 'finished',
          outcome,
          durationMs,
          ...(error ? { error } : {}),
        });
      }
    }
  };

  const expireIncident = (generation: number): void => {
    if (disposed || generation !== incidentGeneration || incidentSession === null) return;
    const remaining = incidentDeadline - now();
    if (remaining > 0) {
      incidentTimer = schedule(() => expireIncident(generation), remaining);
      return;
    }
    const session = incidentSession;
    const holder = options.sessions.getSnapshot();
    const error = holder.session === session ? (holder.sessionSnapshot?.error ?? null) : null;
    releaseIncident('failure', error);
    terminalSession = session;
    publish({ status: 'refreshRequired', error });
    session.disconnect();
  };

  const beginIncident = (
    session: NonNullable<typeof incidentSession>,
    syncRevision: number,
  ): void => {
    if (incidentSession !== session) {
      releaseIncident();
      incidentSession = session;
      incidentRevision = syncRevision;
      incidentDeadline = now() + SESSION_RECOVERY_BUDGET_MS;
      const generation = incidentGeneration;
      incidentTimer = schedule(() => expireIncident(generation), SESSION_RECOVERY_BUDGET_MS);
      for (const subscriber of attemptSubscribers) subscriber({ phase: 'started' });
    }
  };

  const terminate = (
    session: NonNullable<typeof incidentSession>,
    next: Extract<SessionRecoverySnapshot, { status: 'permanentFailure' | 'refreshRequired' }>,
  ): void => {
    releaseIncident('failure', next.error);
    terminalSession = session;
    publish(next);
    session.disconnect();
  };

  const terminateForError = (
    session: NonNullable<typeof incidentSession>,
    error: ClientError,
  ): boolean => {
    if (isPermanentAuthorityFailure(error)) {
      terminate(session, { status: 'permanentFailure', error });
      return true;
    }
    if (requiresRefresh(error)) {
      terminate(session, { status: 'refreshRequired', error });
      return true;
    }
    return false;
  };

  const scheduleConfirmation = (error: ClientError | null): void => {
    if (error?.kind === 'server' && error.error.code === PUBLIC_ERROR_CODE.RATE_LIMITED) {
      if (error !== rateLimitError) {
        rateLimitError = error;
        confirmationNotBefore = Math.max(
          confirmationNotBefore,
          now() + error.error.params.retryAfterMs,
        );
        cancelConfirmation();
      }
    }
    if (confirmationTimer !== null) return;
    const delay = Math.max(CONFIRMATION_INTERVAL_MS, confirmationNotBefore - now());
    if (delay >= incidentDeadline - now()) return;
    const generation = incidentGeneration;
    const session = incidentSession;
    confirmationTimer = schedule(() => {
      if (
        disposed ||
        generation !== incidentGeneration ||
        incidentSession !== session ||
        options.sessions.getSnapshot().session !== session
      )
        return;
      confirmationTimer = null;
      const current = options.sessions.getSnapshot().sessionSnapshot;
      if (now() >= incidentDeadline) {
        expireIncident(generation);
        return;
      }
      if (current?.connection === 'connected' && current.syncStatus === 'idle') {
        requestSynchronization();
      }
    }, delay);
  };

  const observe = (): void => {
    if (disposed) return;
    const { session, sessionSnapshot: current } = options.sessions.getSnapshot();
    const authenticatedWaiting =
      current?.game === null && current.room?.status === 'waiting' && current.syncRevision > 0;
    if (
      session === null ||
      current === null ||
      (current.game?.match.status !== 'playing' && !authenticatedWaiting)
    ) {
      releaseIncident();
      terminalSession = null;
      publish(IDLE);
      return;
    }
    if (current.connection === 'disposed') {
      releaseIncident();
      terminalSession = null;
      publish(IDLE);
      return;
    }
    if (terminalSession === session) return;
    if (terminalSession !== null) {
      terminalSession = null;
      publish(IDLE);
    }
    if (incidentSession !== null && incidentSession !== session) {
      releaseIncident();
      publish(IDLE);
    }
    if (current.error !== null && terminateForError(session, current.error)) return;
    const needsRecovery =
      current.connection === 'disconnected' ||
      current.syncStatus === 'synchronizing' ||
      current.error !== null;
    if (incidentSession === null && needsRecovery) beginIncident(session, current.syncRevision);
    if (incidentSession === null) return;
    if (now() >= incidentDeadline) {
      expireIncident(incidentGeneration);
      return;
    }
    if (
      current.connection === 'connected' &&
      current.syncStatus === 'idle' &&
      current.error === null &&
      current.syncRevision > incidentRevision
    ) {
      if (refreshAfterSynchronizationSession === session) {
        terminate(session, { status: 'refreshRequired', error: null });
        return;
      }
      releaseIncident('success');
      publish(IDLE);
      return;
    }
    if (current.connection === 'connected' && current.syncStatus === 'idle') {
      scheduleConfirmation(current.error);
    } else {
      cancelConfirmation();
    }
    publish({
      status: current.connection === 'connected' ? 'synchronizing' : 'reconnecting',
    });
  };

  function requestSynchronization(requireRefresh: boolean = false): void {
    if (disposed) return;
    const { session, sessionSnapshot: current } = options.sessions.getSnapshot();
    const authenticatedWaiting =
      current?.game === null &&
      current.room?.status === 'waiting' &&
      current.syncRevision > 0 &&
      incidentSession === session;
    if (
      session === null ||
      current === null ||
      (current.game?.match.status !== 'playing' && !authenticatedWaiting)
    )
      return;
    if (terminalSession === session) return;
    beginIncident(session, current.syncRevision);
    const generation = incidentGeneration;
    const isCurrent = (): boolean =>
      !disposed &&
      generation === incidentGeneration &&
      incidentSession === session &&
      options.sessions.getSnapshot().session === session;
    if (!isCurrent()) return;
    if (requireRefresh) refreshAfterSynchronizationSession = session;
    if (current.connection !== 'connected') {
      publish({ status: 'reconnecting' });
      return;
    }
    publish({ status: 'synchronizing' });
    if (!isCurrent()) return;
    if (now() >= incidentDeadline) {
      expireIncident(incidentGeneration);
      return;
    }
    if (current.syncStatus === 'idle' && now() < confirmationNotBefore) {
      scheduleConfirmation(current.error);
      return;
    }
    cancelConfirmation();
    void session.synchronize().then(
      () => {
        if (isCurrent()) observe();
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        options.onUnexpected?.(error);
        observe();
      },
    );
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    subscribeAttempt(listener: (event: RecoveryAttemptEvent) => void) {
      if (disposed) return () => {};
      attemptSubscribers.add(listener);
      return () => attemptSubscribers.delete(listener);
    },
    start() {
      if (started || disposed) return;
      started = true;
      unsubscribeSessions = options.sessions.subscribe(observe);
      unsubscribeForeground = subscribeForeground(requestSynchronization);
      observe();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeSessions?.();
      unsubscribeSessions = null;
      unsubscribeForeground?.();
      unsubscribeForeground = null;
      releaseIncident();
      terminalSession = null;
      subscribers.clear();
      attemptSubscribers.clear();
    },
    requestSynchronization,
    requireRefreshAfterSynchronization: () => requestSynchronization(true),
    reportCommandError(error: ClientError) {
      if (disposed) return;
      const { session, sessionSnapshot: current } = options.sessions.getSnapshot();
      if (session === null || current === null || current.game?.match.status !== 'playing') return;
      if (terminalSession === session) return;
      if (terminateForError(session, error)) return;
      if (error.kind === 'server') return;
      observe();
    },
  };
}

function requiresRefresh(error: ClientError): boolean {
  return (
    (error.kind === 'protocol' &&
      (error.code === CLIENT_ERROR_CODE.PROTOCOL_MISMATCH ||
        error.code === CLIENT_ERROR_CODE.INVALID_RESPONSE ||
        error.code === CLIENT_ERROR_CODE.STATE_UNAVAILABLE)) ||
    (error.kind === 'server' && error.error.code === PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH)
  );
}

function defaultSubscribeForeground(listener: () => void): () => void {
  if (typeof document === 'undefined') return () => {};
  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') listener();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return () => document.removeEventListener('visibilitychange', onVisibilityChange);
}
