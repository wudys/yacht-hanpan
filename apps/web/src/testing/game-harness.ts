import type {
  CommandResult,
  GameSession,
  GameSessionSnapshot,
  RoomAuthority,
} from '@repo/game-client-sdk';
import {
  type GameSnapshot,
  type GameSnapshotInput,
  parseGameSnapshot,
  parsePresenceSnapshot,
  parseRoomView,
  type PublicRoom,
  type ResolvedRollArtifact,
} from '@repo/game-protocol/socket';
import { vi } from 'vitest';

import type { ProductAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import type { DicePresentation, DicePresentationSnapshot } from '@/runtime/dice/dice-presentation';
import {
  type BrowserSessionStore,
  createBrowserSessionStore,
} from '@/runtime/session/browser-session-store';
import type {
  GameSessionHolder,
  GameSessionHolderSnapshot,
} from '@/runtime/session/session-holder';
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

export function createAudio() {
  return {
    supported: true,
    activate: vi.fn<ProductAudioRuntime['activate']>(async () => {}),
    prepareCues: vi.fn<ProductAudioRuntime['prepareCues']>(async () => {}),
    playCue: vi.fn<ProductAudioRuntime['playCue']>(),
    prefetchScenes: vi.fn<ProductAudioRuntime['prefetchScenes']>(async () => {}),
    setBgmEnabled: vi.fn<ProductAudioRuntime['setBgmEnabled']>(async () => {}),
    setScene: vi.fn<ProductAudioRuntime['setScene']>(async () => {}),
    setSfxEnabled: vi.fn<ProductAudioRuntime['setSfxEnabled']>(),
    stopCue: vi.fn<ProductAudioRuntime['stopCue']>(),
    dispose: vi.fn<ProductAudioRuntime['dispose']>(async () => {}),
  } satisfies ProductAudioRuntime;
}

export function createRecovery() {
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

export function createStore() {
  const store = createBrowserSessionStore({
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
    removeRoom: vi.fn<BrowserSessionStore['removeRoom']>(store.removeRoom),
  } satisfies BrowserSessionStore;
}

export function createPresentation() {
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
    prepare: vi.fn<DicePresentation['prepare']>(async () => {}),
    start: vi.fn<DicePresentation['start']>(),
    setResources: vi.fn<DicePresentation['setResources']>(),
    completePlayback: vi.fn<DicePresentation['completePlayback']>(),
    dispose: vi.fn<DicePresentation['dispose']>(),
    publish(next: DicePresentationSnapshot) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  } satisfies DicePresentation & { publish(next: DicePresentationSnapshot): void };
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

export function createSession(snapshot: GameSessionSnapshot = sessionSnapshot()) {
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
  const session = createSession(sessionSnapshot(game, presentedRoom));
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
    installAuthority: vi.fn<GameSessionHolder['installAuthority']>((nextAuthority) => {
      const nextSession = createSession();
      snapshot = {
        ...snapshot,
        authority: nextAuthority,
        session: nextSession,
        sessionSnapshot: nextSession.getSnapshot(),
      };
      publish();
      return nextSession;
    }),
    setRoom: vi.fn<GameSessionHolder['setRoom']>((nextRoom) => {
      if (snapshot.sessionSnapshot.room !== null) return;
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
