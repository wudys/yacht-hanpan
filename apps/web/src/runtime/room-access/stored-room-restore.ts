import type {
  GameClient,
  GameSession,
  GameSessionSnapshot,
  RoomAuthority,
} from '@repo/game-client-sdk';
import {
  CLIENT_ERROR_CODE,
  type ClientError,
  createProtocolError,
} from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';

import type { ServerReadiness } from '@/runtime/network/server-readiness';
import { isPermanentAuthorityFailure } from '@/runtime/session/authority-failure';
import type { BrowserSessionStore, RecentRoom } from '@/runtime/session/browser-session-store';
import type { RecoveryAttemptEvent } from '@/runtime/session/recovery-attempt';
import type { GameSessionHolder } from '@/runtime/session/session-holder';

const REENTRY_CONNECT_BUDGET_MS = 30_000;

export type StoredRoomRestoreSnapshot =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'checking' }>
  | Readonly<{ status: 'connecting' }>
  | Readonly<{ status: 'synchronizing' }>
  | Readonly<{ status: 'waiting'; roomCode: string; expiresAt: number }>
  | Readonly<{ status: 'playing' }>
  | Readonly<{ status: 'permanentFailure'; error: ClientError }>
  | Readonly<{ status: 'refreshRequired'; error: ClientError | null; reason?: 'storage' }>;

export interface StoredRoomRestore {
  check(): void;
  completeHandoff(): void;
  confirmPermanentFailure(): void;
  getSnapshot(): StoredRoomRestoreSnapshot;
  subscribe(listener: () => void): () => void;
  subscribeAttempt(listener: (event: RecoveryAttemptEvent) => void): () => void;
  dispose(): void;
}

type CreateStoredRoomRestoreOptions = Readonly<{
  client: Pick<GameClient, 'resumeRoom'>;
  readiness: ServerReadiness;
  sessions: GameSessionHolder;
  store: BrowserSessionStore;
  onUnexpected?: (error: unknown) => void;
  now?: () => number;
}>;

const IDLE: StoredRoomRestoreSnapshot = { status: 'idle' };

export function createStoredRoomRestore(
  options: CreateStoredRoomRestoreOptions,
): StoredRoomRestore {
  const now = options.now ?? (() => globalThis.performance.now());
  let snapshot = IDLE;
  let disposed = false;
  let generation = 0;
  let recentRoom: RecentRoom | null = null;
  let operation: AbortController | null = null;
  let connectionTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribeSession: (() => void) | null = null;
  let incidentSession: GameSession | null = null;
  let failedIncident: Readonly<{ session: GameSession; game: GameSessionSnapshot['game'] }> | null =
    null;
  let synchronization: ReturnType<GameSession['synchronize']> | null = null;
  let synchronizationConfirmed = false;
  const subscribers = new Set<() => void>();
  const attemptSubscribers = new Set<(event: RecoveryAttemptEvent) => void>();
  let attemptStartedAt: number | null = null;

  const notifyAttempt = (event: RecoveryAttemptEvent): void => {
    for (const subscriber of attemptSubscribers) subscriber(event);
  };

  const finishAttempt = (
    outcome: 'success' | 'failure' | 'cancelled',
    error?: ClientError | null,
  ): void => {
    if (attemptStartedAt === null) return;
    const durationMs = Math.max(0, now() - attemptStartedAt);
    attemptStartedAt = null;
    notifyAttempt({ phase: 'finished', outcome, durationMs, ...(error ? { error } : {}) });
  };

  const publish = (next: StoredRoomRestoreSnapshot): void => {
    if (disposed || snapshot === next) return;
    snapshot = next;
    if (next.status === 'checking' && attemptStartedAt === null) {
      attemptStartedAt = now();
      notifyAttempt({ phase: 'started' });
    } else if (
      attemptStartedAt !== null &&
      next.status !== 'connecting' &&
      next.status !== 'synchronizing' &&
      next.status !== 'checking'
    ) {
      finishAttempt(
        next.status === 'waiting' || next.status === 'playing'
          ? 'success'
          : next.status === 'idle'
            ? 'cancelled'
            : 'failure',
        'error' in next ? next.error : null,
      );
    }
    for (const subscriber of subscribers) subscriber();
  };

  const releaseIncident = (disconnect: boolean): void => {
    generation += 1;
    operation?.abort();
    operation = null;
    if (connectionTimer !== null) clearTimeout(connectionTimer);
    connectionTimer = null;
    unsubscribeSession?.();
    unsubscribeSession = null;
    if (disconnect) incidentSession?.disconnect();
    incidentSession = null;
    synchronization = null;
    synchronizationConfirmed = false;
  };

  const isCurrent = (currentGeneration: number): boolean =>
    !disposed && generation === currentGeneration;

  const failFromClientError = (error: ClientError, completed: boolean = false): void => {
    if (isPermanentAuthorityFailure(error)) {
      const current = options.sessions.getSnapshot();
      if (incidentSession !== null && current.session === incidentSession)
        failedIncident = { session: incidentSession, game: current.sessionSnapshot.game };
      releaseIncident(true);
      publish({ status: 'permanentFailure', error });
      return;
    }
    if (completed || error.kind === 'protocol' || isProtocolMismatch(error)) {
      releaseIncident(true);
      publish({ status: 'refreshRequired', error });
    }
  };

  const observeSession = (currentGeneration: number, session: GameSession): void => {
    if (!isCurrent(currentGeneration)) return;
    const current = options.sessions.getSnapshot();
    if (current.session !== session || current.authority === null || current.room === null) {
      releaseIncident(false);
      publish(IDLE);
      return;
    }
    const { sessionSnapshot } = current;
    if (sessionSnapshot.error !== null) {
      failFromClientError(sessionSnapshot.error);
      if (!isCurrent(currentGeneration)) return;
    }
    if (sessionSnapshot.connection !== 'connected') {
      synchronizationConfirmed = false;
      return;
    }
    if (!synchronizationConfirmed) {
      publish({ status: 'synchronizing' });
      if (synchronization === null) {
        const pending = session.synchronize();
        synchronization = pending;
        void pending.then(
          (result) => {
            if (!isCurrent(currentGeneration) || synchronization !== pending) return;
            synchronization = null;
            if (!result.ok) {
              failFromClientError(result.error, true);
              return;
            }
            synchronizationConfirmed = true;
            observeSession(currentGeneration, session);
          },
          (error: unknown) => {
            if (!isCurrent(currentGeneration) || synchronization !== pending) return;
            options.onUnexpected?.(error);
            synchronization = null;
            releaseIncident(true);
            publish({ status: 'refreshRequired', error: null });
          },
        );
      }
      return;
    }
    if (sessionSnapshot.presence === null) return;
    if (sessionSnapshot.game !== null) {
      releaseIncident(false);
      publish({ status: 'playing' });
      return;
    }
    if (current.room.status === 'waiting') {
      releaseIncident(false);
      publish({
        status: 'waiting',
        roomCode: current.room.roomCode,
        expiresAt: current.room.expiresAt,
      });
      return;
    }
    publish({ status: 'synchronizing' });
  };

  const run = async (currentGeneration: number, savedRoom: RecentRoom): Promise<void> => {
    const readiness = await options.readiness.wait(operation?.signal);
    if (!isCurrent(currentGeneration)) return;
    if (!readiness.ok) {
      if (readiness.reason !== 'cancelled') {
        releaseIncident(false);
        publish({
          status: 'refreshRequired',
          error:
            readiness.reason === 'invalid-response'
              ? createProtocolError(CLIENT_ERROR_CODE.INVALID_RESPONSE)
              : null,
        });
      }
      return;
    }

    connectionTimer = setTimeout(() => {
      if (!isCurrent(currentGeneration)) return;
      releaseIncident(true);
      publish({ status: 'refreshRequired', error: null });
    }, REENTRY_CONNECT_BUDGET_MS);

    const result = await options.client.resumeRoom(
      { roomId: savedRoom.roomId, seatToken: savedRoom.seatToken },
      { signal: operation?.signal },
    );
    if (!isCurrent(currentGeneration)) return;
    if (!result.ok) {
      if (isPermanentAuthorityFailure(result.error)) {
        releaseIncident(false);
        publish({ status: 'permanentFailure', error: result.error });
      } else {
        releaseIncident(false);
        publish({ status: 'refreshRequired', error: result.error });
      }
      return;
    }

    const authority: RoomAuthority = {
      roomId: savedRoom.roomId,
      seatToken: savedRoom.seatToken,
      seatIndex: result.data.seatIndex,
    };
    const session = options.sessions.installAuthority(authority);
    options.sessions.setRoom(result.data.view.room);
    incidentSession = session;
    synchronizationConfirmed = false;
    unsubscribeSession = options.sessions.subscribe(() =>
      observeSession(currentGeneration, session),
    );
    publish({ status: 'connecting' });
    observeSession(currentGeneration, session);

    void session.connect().then(
      (connection) => {
        if (!isCurrent(currentGeneration)) return;
        if (!connection.ok) {
          failFromClientError(connection.error, true);
          return;
        }
        synchronizationConfirmed = true;
        observeSession(currentGeneration, session);
      },
      (error: unknown) => {
        if (!isCurrent(currentGeneration)) return;
        options.onUnexpected?.(error);
        releaseIncident(true);
        publish({ status: 'refreshRequired', error: null });
      },
    );
  };

  return {
    check() {
      if (
        disposed ||
        snapshot.status !== 'idle' ||
        options.sessions.getSnapshot().authority !== null
      )
        return;
      const stored = options.store.refreshRecentRoom();
      if (stored.status === 'unavailable') {
        publish({ status: 'refreshRequired', error: null, reason: 'storage' });
        return;
      }
      recentRoom = stored.room;
      if (recentRoom === null) return;
      const currentGeneration = ++generation;
      failedIncident = null;
      operation = new AbortController();
      publish({ status: 'checking' });
      void run(currentGeneration, recentRoom).catch((error: unknown) => {
        if (!isCurrent(currentGeneration)) return;
        options.onUnexpected?.(error);
        releaseIncident(true);
        publish({ status: 'refreshRequired', error: null });
      });
    },
    completeHandoff() {
      if (snapshot.status !== 'waiting' && snapshot.status !== 'playing') return;
      releaseIncident(false);
      publish(IDLE);
    },
    confirmPermanentFailure() {
      if (disposed || snapshot.status !== 'permanentFailure' || recentRoom === null) return;
      const target = recentRoom;
      const current = options.sessions.getSnapshot();
      if (failedIncident && current.session && current.session !== failedIncident.session) return;
      const failedGame = failedIncident?.session === current.session ? failedIncident.game : null;
      if (
        current.authority &&
        (current.authority.roomId !== target.roomId ||
          current.authority.seatToken !== target.seatToken)
      )
        return;
      if (current.sessionSnapshot?.game && current.sessionSnapshot.game !== failedGame) {
        if (failedIncident?.session === current.session) {
          failedIncident = null;
          recentRoom = null;
          publish(IDLE);
        }
        return;
      }
      recentRoom = null;
      options.store.removeRoom(target.roomId);
      const latest = options.sessions.getSnapshot();
      if (
        !disposed &&
        latest.session === current.session &&
        (!latest.sessionSnapshot?.game || latest.sessionSnapshot.game === failedGame)
      )
        options.sessions.clear();
      failedIncident = null;
      publish(IDLE);
    },
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
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseIncident(true);
      recentRoom = null;
      failedIncident = null;
      finishAttempt('cancelled');
      subscribers.clear();
      attemptSubscribers.clear();
    },
  };
}

function isProtocolMismatch(error: ClientError): boolean {
  return error.kind === 'server' && error.error.code === PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH;
}
