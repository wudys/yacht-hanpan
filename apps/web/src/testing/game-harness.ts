import type {
  CommandResult,
  GameSession,
  GameSessionSnapshot,
  RoomAuthority,
} from '@repo/game-client-sdk';
import { type ResolvedRollArtifact } from '@repo/game-protocol/socket';
import {
  type GameSnapshot,
  type GameSnapshotInput,
  parseGameSnapshot,
  parsePresenceSnapshot,
  parseRoomView,
  type PublicRoom,
} from '@repo/game-protocol/state';
import { vi } from 'vitest';

import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import type {
  DicePresentationController,
  DicePresentationSnapshot,
} from '@/runtime/dice/dice-presentation-controller';
import type {
  GameSessionHolder,
  GameSessionHolderSnapshot,
} from '@/runtime/session/game-session-holder';
import {
  createSessionCredentialStore,
  type SessionCredentialStore,
} from '@/runtime/session/session-credential-store';
import type { SessionRecovery, SessionRecoverySnapshot } from '@/runtime/session/session-recovery';
import { authority, commandSuccess, playingGame, room } from '@/testing/game-fixtures';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

export function createAudioMock() {
  return {
    supported: true,
    activate: vi.fn<BrowserAudioRuntime['activate']>(async () => {}),
    prepareCues: vi.fn<BrowserAudioRuntime['prepareCues']>(async () => {}),
    playCue: vi.fn<BrowserAudioRuntime['playCue']>(),
    prefetchScenes: vi.fn<BrowserAudioRuntime['prefetchScenes']>(async () => {}),
    setBgmEnabled: vi.fn<BrowserAudioRuntime['setBgmEnabled']>(async () => {}),
    setScene: vi.fn<BrowserAudioRuntime['setScene']>(async () => {}),
    setSfxEnabled: vi.fn<BrowserAudioRuntime['setSfxEnabled']>(),
    setSurfaceExposed: vi.fn<BrowserAudioRuntime['setSurfaceExposed']>(),
    stopCue: vi.fn<BrowserAudioRuntime['stopCue']>(),
    dispose: vi.fn<BrowserAudioRuntime['dispose']>(async () => {}),
  } satisfies BrowserAudioRuntime;
}

export function createRecoveryFake() {
  let snapshot: SessionRecoverySnapshot = { status: 'idle' };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeAttempt: vi.fn<SessionRecovery['subscribeAttempt']>(() => () => {}),
    start: vi.fn<SessionRecovery['start']>(),
    dispose: vi.fn<SessionRecovery['dispose']>(),
    requestSynchronization: vi.fn<SessionRecovery['requestSynchronization']>(),
    requireRefreshAfterSynchronization:
      vi.fn<SessionRecovery['requireRefreshAfterSynchronization']>(),
    reportCommandError: vi.fn<SessionRecovery['reportCommandError']>(),
    publish(next: SessionRecoverySnapshot) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  } satisfies SessionRecovery & { publish(next: SessionRecoverySnapshot): void };
}

export function createSessionCredentialStoreSpy() {
  const store = createSessionCredentialStore({
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    createClientId: () => '019976a2-d8d8-7000-8000-000000000002',
  });
  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    initialize: vi.fn(store.initialize),
    getClientId: vi.fn(store.getClientId),
    refreshRecentRoom: vi.fn(store.refreshRecentRoom),
    recordRoom: vi.fn(store.recordRoom),
    removeRoom: vi.fn<SessionCredentialStore['removeRoom']>(store.removeRoom),
  } satisfies SessionCredentialStore;
}

export function createPresentationFake() {
  let snapshot: DicePresentationSnapshot = { phase: 'settled', resources: null, dice: [] };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish(next: DicePresentationSnapshot) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  } satisfies Pick<DicePresentationController, 'getSnapshot' | 'subscribe'> & {
    publish(next: DicePresentationSnapshot): void;
  };
}

function gameRoomView(game: GameSnapshotInput | GameSnapshot, presentedRoom: PublicRoom) {
  const publicRoom =
    game.match.status === 'finished' && presentedRoom.status === 'playing'
      ? { ...presentedRoom, status: 'finished', finishedAt: 10_000 }
      : presentedRoom;
  return parseRoomView({
    room: publicRoom,
    game,
    presence: {
      roomId: presentedRoom.roomId,
      presenceVersion: 1,
      seats: [{ status: 'connected' }, { status: 'connected' }],
    },
  });
}

function assertSessionView({ room, game, presence }: GameSessionSnapshot) {
  if (room === null && game === null && presence === null) return;
  parseRoomView({ room, game, presence });
}

function sessionSnapshot(
  game: GameSnapshotInput | GameSnapshot = playingGame,
  presentedRoom: PublicRoom = room,
): GameSessionSnapshot {
  return {
    connection: 'connected',
    syncStatus: 'idle',
    syncRevision: 1,
    ...gameRoomView(game, presentedRoom),
    presentation: { kind: 'settled' },
    error: null,
  };
}

export function createSessionMock(snapshot: GameSessionSnapshot = sessionSnapshot()) {
  assertSessionView(snapshot);
  const getSnapshot = vi.fn(() => snapshot);
  const success = () => commandSuccess(getSnapshot().game?.stateVersion);
  return {
    connect: vi.fn<GameSession['connect']>(async () => ({ ok: true })),
    synchronize: vi.fn<GameSession['synchronize']>(async () => ({ ok: true })),
    disconnect: vi.fn<GameSession['disconnect']>(),
    dispose: vi.fn<GameSession['dispose']>(),
    getSnapshot,
    subscribe: vi.fn<GameSession['subscribe']>(() => () => {}),
    rollDice: vi.fn<GameSession['rollDice']>(async () => success()),
    setDieHeld: vi.fn<GameSession['setDieHeld']>(async () => success()),
    selectScoreCategory: vi.fn<GameSession['selectScoreCategory']>(async () => success()),
    forfeitMatch: vi.fn<GameSession['forfeitMatch']>(async () => success()),
  } satisfies GameSession;
}

export function createGameSessionHarness(
  game: GameSnapshotInput | GameSnapshot = playingGame,
  presentedRoom: PublicRoom = room,
) {
  const roll = deferred<CommandResult>();
  const session = createSessionMock(sessionSnapshot(game, presentedRoom));
  session.rollDice.mockImplementation(() => roll.promise);
  let snapshot: Extract<GameSessionHolderSnapshot, { authority: RoomAuthority }> = {
    authority,
    room: session.getSnapshot().room,
    session,
    sessionSnapshot: session.getSnapshot(),
  };
  const listeners = new Set<() => void>();
  const publish = () => {
    assertSessionView(snapshot.sessionSnapshot);
    if (
      snapshot.sessionSnapshot.room !== null &&
      snapshot.sessionSnapshot.room.roomId !== snapshot.authority.roomId
    )
      throw new Error('Expected the session view to match its authority');
    snapshot = { ...snapshot, room: snapshot.sessionSnapshot.room ?? snapshot.room };
    vi.mocked(snapshot.session.getSnapshot).mockReturnValue(snapshot.sessionSnapshot);
    listeners.forEach((listener) => listener());
  };
  const sessions = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // Screen tests observe navigation separately; retain the rendered final snapshot on clear.
    clear: vi.fn<GameSessionHolder['clear']>(),
    detachFinishedSession: vi.fn<GameSessionHolder['detachFinishedSession']>((expectedSession) => {
      if (
        snapshot.session !== expectedSession ||
        snapshot.sessionSnapshot.game?.match.status !== 'finished'
      )
        return false;
      expectedSession.dispose();
      return true;
    }),
    dispose: vi.fn<GameSessionHolder['dispose']>(),
    installAuthority: vi.fn<GameSessionHolder['installAuthority']>((nextAuthority, initialRoom) => {
      const nextSession = createSessionMock();
      const sessionSnapshot = nextSession.getSnapshot();
      snapshot = {
        ...snapshot,
        authority: nextAuthority,
        room:
          sessionSnapshot.room ??
          (initialRoom?.roomId === nextAuthority.roomId ? initialRoom : null),
        session: nextSession,
        sessionSnapshot,
      };
      publish();
      return nextSession;
    }),
    setProvisionalRoom: vi.fn<GameSessionHolder['setProvisionalRoom']>((nextRoom) => {
      if (
        snapshot.sessionSnapshot.room !== null ||
        nextRoom.roomId !== snapshot.authority.roomId ||
        snapshot.room === nextRoom ||
        (nextRoom.status === 'waiting' &&
          snapshot.room !== null &&
          snapshot.room.status !== 'waiting')
      )
        return;
      snapshot = { ...snapshot, room: nextRoom };
      publish();
    }),
    publish(next: GameSnapshotInput | GameSnapshot, roll: ResolvedRollArtifact | null = null) {
      const game = parseGameSnapshot(next);
      const view = gameRoomView(game, snapshot.room ?? room);
      snapshot = {
        ...snapshot,
        sessionSnapshot: {
          ...snapshot.sessionSnapshot,
          ...view,
          presence: snapshot.sessionSnapshot.presence ?? view.presence,
          presentation:
            roll && game.match.status === 'playing'
              ? {
                  kind: 'roll',
                  roll,
                }
              : { kind: 'settled' },
        },
      };
      publish();
    },
    publishOpponentConnection(connected: boolean) {
      const { presence } = snapshot.sessionSnapshot;
      if (presence === null) throw new Error('Expected presence fixture');
      snapshot = {
        ...snapshot,
        sessionSnapshot: {
          ...snapshot.sessionSnapshot,
          presence: parsePresenceSnapshot({
            roomId: snapshot.authority.roomId,
            presenceVersion: Number(presence.presenceVersion) + 1,
            seats: [
              { status: 'connected' },
              connected
                ? { status: 'connected' }
                : { status: 'disconnected', reconnectDeadlineAt: 61000 },
            ],
          }),
        },
      };
      publish();
    },
    replaceSession(next: GameSession, nextAuthority: RoomAuthority = snapshot.authority) {
      snapshot = {
        ...snapshot,
        authority: nextAuthority,
        session: next,
        sessionSnapshot: next.getSnapshot(),
      };
      publish();
    },
  } satisfies GameSessionHolder & {
    publish(next: GameSnapshotInput | GameSnapshot, roll?: ResolvedRollArtifact | null): void;
    publishOpponentConnection(connected: boolean): void;
    replaceSession(next: GameSession, nextAuthority?: RoomAuthority): void;
  };
  return { roll, session, sessions };
}
