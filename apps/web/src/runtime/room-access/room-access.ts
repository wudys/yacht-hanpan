import type { GameClient, GameSession } from '@repo/game-client-sdk';
import type { ClientError } from '@repo/game-client-sdk/errors';

import type { ServerReadiness } from '@/runtime/network/server-readiness';
import type { ProfileSelectionStore } from '@/runtime/profile/profile-selection-store';
import type { StoredRoomReentry } from '@/runtime/room-access/stored-room-reentry';
import {
  type Cancellation,
  createWaitingOperations,
  type ExpiryCheck,
  type WaitingRoomSummary,
} from '@/runtime/room-access/waiting-operations';
import { isPermanentAuthorityFailure } from '@/runtime/session/authority-failure';
import type { GameSessionHolder } from '@/runtime/session/game-session-holder';
import type { SessionCredentialStore } from '@/runtime/session/session-credential-store';
import type { SessionRecovery } from '@/runtime/session/session-recovery';

type Profile = ReturnType<ProfileSelectionStore['getSnapshot']>['selection'];
export type ReadinessFailure = Extract<Awaited<ReturnType<ServerReadiness['wait']>>, { ok: false }>;
export type {
  Cancellation,
  ExpiryCheck,
  WaitingRoomSummary,
} from '@/runtime/room-access/waiting-operations';
export type AdmissionResult =
  | Readonly<{ status: 'installed'; waitingRoom: WaitingRoomSummary | null }>
  | Readonly<{ status: 'blocked' | 'stale' }>
  | Readonly<{ status: 'failure'; stage: 'readiness'; readiness: ReadinessFailure }>
  | Readonly<{ status: 'failure'; stage: 'response'; error: ClientError }>;
type LocalPhase =
  | Readonly<{ status: 'idle' | 'cancelling' | 'checkingExpiry' }>
  | Readonly<{ status: 'preparing' | 'requesting'; operation: 'create' | 'join' }>
  | Readonly<{ status: 'connectionFailure'; error: ClientError | null; cause?: unknown }>;
export type RoomAccessSnapshot =
  | Readonly<{
      status: 'idle' | 'matching' | 'cancelling' | 'checkingExpiry' | 'disposed' | 'replaced';
    }>
  | Readonly<{ status: 'preparing' | 'requesting'; operation: 'create' | 'join' }>
  | Readonly<{ status: 'restoring'; phase: 'checking' | 'connecting' | 'synchronizing' }>
  | Readonly<{ status: 'handoff'; origin: 'restore' | 'session'; target: 'game' }>
  | Readonly<{ status: 'handoff'; origin: 'restore'; target: 'waiting'; room: WaitingRoomSummary }>
  | Readonly<{
      status: 'waiting';
      room: WaitingRoomSummary;
      recovery: 'idle' | 'reconnecting' | 'synchronizing';
    }>
  | Readonly<{ status: 'authorityFailure'; origin: 'restore' | 'session'; error: ClientError }>
  | Readonly<{
      status: 'refreshRequired';
      origin: 'restore' | 'session';
      error: ClientError | null;
      reason?: 'storage';
    }>
  | Readonly<{ status: 'connectionFailure'; error: ClientError | null; cause?: unknown }>;

function sameSnapshot(left: RoomAccessSnapshot, right: RoomAccessSnapshot): boolean {
  if (left.status !== right.status) return false;
  switch (right.status) {
    case 'preparing':
    case 'requesting':
      return left.status === right.status && left.operation === right.operation;
    case 'restoring':
      return left.status === 'restoring' && left.phase === right.phase;
    case 'waiting':
      return (
        left.status === 'waiting' &&
        left.room.roomCode === right.room.roomCode &&
        left.room.expiresAt === right.room.expiresAt &&
        left.recovery === right.recovery
      );
    case 'handoff':
      return (
        left.status === 'handoff' &&
        left.origin === right.origin &&
        left.target === right.target &&
        (right.target === 'game' ||
          (left.target === 'waiting' &&
            left.room.roomCode === right.room.roomCode &&
            left.room.expiresAt === right.room.expiresAt))
      );
    case 'authorityFailure':
      return (
        left.status === 'authorityFailure' &&
        left.origin === right.origin &&
        left.error === right.error
      );
    case 'refreshRequired':
      return (
        left.status === 'refreshRequired' &&
        left.origin === right.origin &&
        left.error === right.error &&
        left.reason === right.reason
      );
    case 'connectionFailure':
      return (
        left.status === 'connectionFailure' &&
        left.error === right.error &&
        left.cause === right.cause
      );
    default:
      return true;
  }
}
export interface RoomAccess {
  getSnapshot(): RoomAccessSnapshot;
  subscribe(listener: () => void): () => void;
  checkStoredRoom(): void;
  create(profile: Profile, signal: AbortSignal): Promise<AdmissionResult>;
  join(
    input: { profile: Profile; roomCode: string },
    signal: AbortSignal,
  ): Promise<AdmissionResult>;
  cancelWaiting(
    signal: AbortSignal,
    onResponse: (error?: ClientError) => void,
  ): Promise<Cancellation>;
  checkWaitingExpiry(signal: AbortSignal): Promise<ExpiryCheck>;
  confirmAuthorityFailure(): void;
  completeHandoff(): void;
  dispose(): void;
}

export function createRoomAccess({
  activity,
  client,
  sessions,
  sessionCredentialStore,
  readiness,
  reentry,
  recovery,
}: Readonly<{
  activity: AbortSignal;
  client: Pick<GameClient, 'createRoom' | 'joinRoom' | 'cancelRoom' | 'resumeRoom'>;
  sessions: GameSessionHolder;
  sessionCredentialStore: SessionCredentialStore;
  readiness: ServerReadiness;
  reentry: StoredRoomReentry;
  recovery: Pick<SessionRecovery, 'getSnapshot' | 'subscribe'>;
}>): RoomAccess {
  let snapshot: RoomAccessSnapshot = { status: 'idle' };
  let disposed = false;
  let generation = 0;
  let operation: AbortController | null = null;
  let failedSession: GameSession | null = null;
  let restoreSession: GameSession | null = null;
  const waiting = createWaitingOperations({ client, sessions, sessionCredentialStore });
  let phase: LocalPhase = { status: 'idle' };
  let connectionSession: GameSession | null = null;
  let handoffScheduled = false;
  let notificationScheduled = false;
  const subscribers = new Set<() => void>();

  function compose(): RoomAccessSnapshot {
    if (disposed) return { status: 'disposed' };
    if (activity.aborted) return { status: 'replaced' };
    const restored = reentry.getSnapshot();
    const holder = sessions.getSnapshot();
    if (restored.status === 'playing')
      return { status: 'handoff', origin: 'restore', target: 'game' };
    if (
      restored.status === 'checking' ||
      restored.status === 'connecting' ||
      restored.status === 'synchronizing'
    )
      return { status: 'restoring', phase: restored.status };
    if (
      (restored.status === 'refreshRequired' || restored.status === 'permanentFailure') &&
      holder.session !== null &&
      holder.session === restoreSession
    )
      return restored.status === 'permanentFailure'
        ? { status: 'authorityFailure', origin: 'restore', error: restored.error }
        : {
            status: 'refreshRequired',
            origin: 'restore',
            error: restored.error,
            ...(restored.reason ? { reason: restored.reason } : {}),
          };
    if (holder.sessionSnapshot?.game)
      return { status: 'handoff', origin: 'session', target: 'game' };
    if (restored.status === 'waiting')
      return {
        status: 'handoff',
        origin: 'restore',
        target: 'waiting',
        room: { roomCode: restored.roomCode, expiresAt: restored.expiresAt },
      };
    if (restored.status === 'permanentFailure')
      return { status: 'authorityFailure', origin: 'restore', error: restored.error };
    if (restored.status === 'refreshRequired')
      return {
        status: 'refreshRequired',
        origin: 'restore',
        error: restored.error,
        ...(restored.reason ? { reason: restored.reason } : {}),
      };
    if (
      operation &&
      (phase.status === 'cancelling' ||
        phase.status === 'checkingExpiry' ||
        phase.status === 'preparing' ||
        phase.status === 'requesting')
    )
      return phase.status === 'preparing' || phase.status === 'requesting'
        ? phase
        : { status: phase.status };
    const recovering = recovery.getSnapshot();
    if (holder.session && recovering.status === 'permanentFailure')
      return { status: 'authorityFailure', origin: 'session', error: recovering.error };
    if (holder.session && recovering.status === 'refreshRequired')
      return { status: 'refreshRequired', origin: 'session', error: recovering.error };
    if (phase.status === 'connectionFailure' && holder.session === connectionSession) return phase;
    if (holder.room?.status === 'waiting')
      return {
        status: 'waiting',
        room: { roomCode: holder.room.roomCode, expiresAt: holder.room.expiresAt },
        recovery:
          recovering.status === 'reconnecting' || recovering.status === 'synchronizing'
            ? recovering.status
            : 'idle',
      };
    if (holder.session) return { status: 'matching' };
    return { status: 'idle' };
  }
  const notify = () => {
    for (const subscriber of subscribers) subscriber();
  };
  function refresh(defer: boolean = true) {
    const next = compose();
    if (sameSnapshot(snapshot, next)) return;
    snapshot = next; // Reads immediately reflect authority; route reactions are coalesced.
    if (!defer) {
      notify();
      return;
    }
    if (notificationScheduled) return;
    notificationScheduled = true;
    queueMicrotask(() => {
      notificationScheduled = false;
      if (!disposed) notify();
    });
  }
  const changed = () => refresh();
  const observeRestore = () => {
    const restored = reentry.getSnapshot();
    if (restored.status === 'connecting' || restored.status === 'synchronizing')
      restoreSession = sessions.getSnapshot().session;
    else if (
      restored.status === 'idle' ||
      restored.status === 'waiting' ||
      restored.status === 'playing'
    )
      restoreSession = null;
    refresh();
  };
  const observeRecovery = () => {
    if (recovery.getSnapshot().status === 'permanentFailure')
      failedSession = sessions.getSnapshot().session;
    refresh();
  };
  const stops = [
    sessions.subscribe(changed),
    reentry.subscribe(observeRestore),
    recovery.subscribe(observeRecovery),
  ];
  activity.addEventListener('abort', changed, { once: true });
  if (
    ['connecting', 'synchronizing', 'refreshRequired', 'permanentFailure'].includes(
      reentry.getSnapshot().status,
    )
  )
    restoreSession = sessions.getSnapshot().session;
  snapshot = compose();
  if (recovery.getSnapshot().status === 'permanentFailure')
    failedSession = sessions.getSnapshot().session;
  const publish = (next: LocalPhase) => {
    if (!disposed) {
      phase = next;
      refresh(false);
    }
  };
  const current = (revision: number, session?: GameSession) =>
    !disposed &&
    !activity.aborted &&
    generation === revision &&
    (session === undefined || sessions.getSnapshot().session === session);

  const ownsSession = (session: GameSession) =>
    !disposed && !activity.aborted && sessions.getSnapshot().session === session;

  function connect(session: GameSession, revision: number) {
    connectionSession = session;
    void Promise.resolve()
      .then(() => (ownsSession(session) ? session.connect() : null))
      .then(
        (result) => {
          if (
            !result ||
            !current(revision, session) ||
            sessions.getSnapshot().sessionSnapshot?.game
          )
            return;
          if (!result.ok) {
            if (isPermanentAuthorityFailure(result.error)) failedSession = session;
            session.disconnect();
            if (current(revision, session))
              publish({ status: 'connectionFailure', error: result.error });
          }
        },
        (cause: unknown) => {
          if (current(revision, session) && !sessions.getSnapshot().sessionSnapshot?.game) {
            session.disconnect();
            if (current(revision, session))
              publish({ status: 'connectionFailure', error: null, cause });
          }
        },
      );
  }

  async function admit(
    kind: 'create' | 'join',
    input: { profile: Profile; roomCode?: string },
    routeSignal: AbortSignal,
  ): Promise<AdmissionResult> {
    if (disposed || activity.aborted || routeSignal.aborted) return { status: 'stale' };
    if (operation !== null) return { status: 'blocked' };
    const controller = new AbortController();
    operation = controller; // Register before publishing: observers may synchronously submit again.
    const revision = ++generation;
    const abort = () => controller.abort();
    routeSignal.addEventListener('abort', abort, { once: true });
    activity.addEventListener('abort', abort, { once: true });
    const active = () => current(revision) && !controller.signal.aborted;
    try {
      reentry.check();
      if (!active()) return { status: 'stale' };
      if (reentry.getSnapshot().status !== 'idle' || sessions.getSnapshot().authority !== null)
        return { status: 'blocked' };
      publish({ status: 'preparing', operation: kind });
      if (!active()) return { status: 'stale' };
      const prepared = await readiness.wait(controller.signal);
      if (!active()) return { status: 'stale' };
      if (sessions.getSnapshot().authority !== null) return { status: 'stale' };
      if (!prepared.ok) return { status: 'failure', stage: 'readiness', readiness: prepared };
      publish({ status: 'requesting', operation: kind });
      if (!active()) return { status: 'stale' };
      if (sessions.getSnapshot().authority !== null) return { status: 'stale' };
      const request = { clientId: sessionCredentialStore.getClientId(), profile: input.profile };
      const result = await (kind === 'create'
        ? client.createRoom(request, { signal: controller.signal })
        : client.joinRoom(
            { ...request, roomCode: input.roomCode! },
            { signal: controller.signal },
          ));
      if (!active()) return { status: 'stale' };
      if (!result.ok) return { status: 'failure', stage: 'response', error: result.error };
      if (sessions.getSnapshot().authority !== null) return { status: 'stale' };
      sessionCredentialStore.recordRoom(result.data.authority);
      if (!active() || sessions.getSnapshot().authority !== null) return { status: 'stale' };
      const session = sessions.installAuthority(result.data.authority);
      if (!active() || !current(revision, session)) return { status: 'stale' };
      sessions.setRoom(result.data.view.room);
      if (!active() || !current(revision, session)) return { status: 'stale' };
      const { room } = result.data.view;
      const waitingRoom =
        room.status === 'waiting' ? { roomCode: room.roomCode, expiresAt: room.expiresAt } : null;
      publish({ status: 'idle' });
      if (!active() || !current(revision, session)) return { status: 'stale' };
      // HTTP admission completes independently from the SDK's initial full synchronization.
      queueMicrotask(() => {
        if (ownsSession(session)) connect(session, revision);
      });
      return { status: 'installed', waitingRoom };
    } finally {
      routeSignal.removeEventListener('abort', abort);
      activity.removeEventListener('abort', abort);
      if (operation === controller) {
        operation = null;
        refresh();
      }
    }
  }

  async function runWaiting<T extends Cancellation | ExpiryCheck>(
    status: 'cancelling' | 'checkingExpiry',
    routeSignal: AbortSignal,
    execute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | { status: 'stale' }> {
    if (disposed || activity.aborted || routeSignal.aborted || operation !== null)
      return { status: 'stale' };
    const controller = new AbortController();
    operation = controller;
    const revision = ++generation; // Cancellation/expiry now own the result; ignore late first-connect callbacks.
    const { session } = sessions.getSnapshot();
    const abort = () => controller.abort();
    routeSignal.addEventListener('abort', abort, { once: true });
    activity.addEventListener('abort', abort, { once: true });
    try {
      publish({ status });
      if (
        !current(revision) ||
        controller.signal.aborted ||
        sessions.getSnapshot().session !== session
      )
        return { status: 'stale' };
      const result = await execute(controller.signal);
      if (!current(revision) || controller.signal.aborted) return { status: 'stale' };
      if (result.status === 'failure' && isPermanentAuthorityFailure(result.error))
        failedSession = session;
      publish({ status: 'idle' });
      return result;
    } catch (cause) {
      if (
        !current(revision) ||
        controller.signal.aborted ||
        sessions.getSnapshot().session !== session ||
        sessions.getSnapshot().sessionSnapshot?.game
      )
        return { status: 'stale' };
      throw cause;
    } finally {
      routeSignal.removeEventListener('abort', abort);
      activity.removeEventListener('abort', abort);
      if (operation === controller) {
        operation = null;
        refresh();
      }
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    checkStoredRoom: () => {
      if (!disposed && !activity.aborted) {
        reentry.check();
        refresh(false);
      }
    },
    create: (profile, signal) => admit('create', { profile }, signal),
    join: (input, signal) => admit('join', input, signal),
    cancelWaiting: (signal, onResponse) =>
      runWaiting('cancelling', signal, (operationSignal) =>
        waiting.cancel(operationSignal, onResponse),
      ),
    checkWaitingExpiry: (signal) =>
      runWaiting('checkingExpiry', signal, (operationSignal) =>
        waiting.checkExpiry(operationSignal),
      ),
    confirmAuthorityFailure() {
      if (disposed || activity.aborted) return;
      if (snapshot.status === 'authorityFailure' && snapshot.origin === 'restore') {
        reentry.confirmPermanentFailure();
        refresh(false);
        return;
      }
      const { session, authority, sessionSnapshot } = sessions.getSnapshot();
      if (!session || session !== failedSession || !authority || sessionSnapshot.game) return;
      sessionCredentialStore.removeRoom(authority.roomId);
      const latest = sessions.getSnapshot();
      if (
        !disposed &&
        !activity.aborted &&
        latest.session === session &&
        !latest.sessionSnapshot?.game
      )
        sessions.clear();
    },
    completeHandoff() {
      const outcome = reentry.getSnapshot();
      if (
        disposed ||
        activity.aborted ||
        handoffScheduled ||
        (outcome.status !== 'waiting' && outcome.status !== 'playing')
      )
        return;
      handoffScheduled = true;
      // Let every source and access observer see the confirmed restore before telemetry attribution changes.
      queueMicrotask(() => {
        handoffScheduled = false;
        if (!disposed && !activity.aborted && reentry.getSnapshot() === outcome)
          reentry.completeHandoff();
      });
    },
    dispose() {
      if (disposed) return;
      generation += 1;
      operation?.abort();
      snapshot = { status: 'disposed' };
      disposed = true;
      for (const stop of stops) stop();
      activity.removeEventListener('abort', changed);
      subscribers.clear();
    },
  };
}
