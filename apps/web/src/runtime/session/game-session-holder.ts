import type {
  GameClient,
  GameSession,
  GameSessionSnapshot,
  RoomAuthority,
} from '@repo/game-client-sdk';
import type { PublicRoom } from '@repo/game-protocol/state';

export type GameSessionHolderSnapshot =
  | Readonly<{
      authority: null;
      room: null;
      session: null;
      sessionSnapshot: null;
    }>
  | Readonly<{
      authority: RoomAuthority;
      room: PublicRoom | null;
      session: GameSession;
      sessionSnapshot: GameSessionSnapshot;
    }>;

export interface GameSessionHolder {
  installAuthority(authority: RoomAuthority, initialRoom?: PublicRoom): GameSession;
  setProvisionalRoom(room: PublicRoom): void;
  /** Stops the matching finished session while retaining its final view until clear or replacement. */
  detachFinishedSession(expectedSession: GameSession): boolean;
  clear(): void;
  dispose(): void;
  getSnapshot(): GameSessionHolderSnapshot;
  subscribe(listener: () => void): () => void;
}

const EMPTY_SNAPSHOT: GameSessionHolderSnapshot = {
  authority: null,
  room: null,
  session: null,
  sessionSnapshot: null,
};

function isSameAuthority(left: RoomAuthority, right: RoomAuthority): boolean {
  return (
    left.roomId === right.roomId &&
    left.seatIndex === right.seatIndex &&
    left.seatToken === right.seatToken
  );
}

export function createGameSessionHolder(
  client: Pick<GameClient, 'createSession'>,
): GameSessionHolder {
  let currentAuthority: RoomAuthority | null = null;
  let currentSession: GameSession | null = null;
  let unsubscribeSession: (() => void) | null = null;
  let view = EMPTY_SNAPSHOT;
  const subscribers = new Set<() => void>();
  let disposed = false;

  function publish(): void {
    for (const subscriber of subscribers) subscriber();
  }

  function releaseCurrentSession(): boolean {
    const session = currentSession;
    if (view.authority === null) return false;
    unsubscribeSession?.();
    unsubscribeSession = null;
    currentAuthority = null;
    currentSession = null;
    view = EMPTY_SNAPSHOT;
    session?.dispose();
    return true;
  }

  function applyProvisionalRoom(room: PublicRoom): boolean {
    if (
      disposed ||
      !currentAuthority ||
      !currentSession ||
      view.authority === null ||
      view.sessionSnapshot.room !== null ||
      room.roomId !== currentAuthority.roomId ||
      view.room === room ||
      (room.status === 'waiting' && view.room !== null && view.room.status !== 'waiting')
    )
      return false;
    view = { ...view, room };
    return true;
  }

  return {
    installAuthority(authority: RoomAuthority, initialRoom?: PublicRoom) {
      if (disposed) throw new Error('Game session holder is disposed');
      if (currentAuthority && currentSession && isSameAuthority(currentAuthority, authority)) {
        const session = currentSession;
        if (initialRoom && applyProvisionalRoom(initialRoom)) publish();
        return session;
      }
      const session = client.createSession(authority);
      releaseCurrentSession();
      currentAuthority = authority;
      currentSession = session;
      const initialSnapshot = session.getSnapshot();
      view = {
        authority,
        room: initialSnapshot.room,
        session,
        sessionSnapshot: initialSnapshot,
      };
      if (initialRoom) applyProvisionalRoom(initialRoom);
      unsubscribeSession = session.subscribe(() => {
        if (currentSession !== session) return;
        const sessionSnapshot = session.getSnapshot();
        if (view.sessionSnapshot === sessionSnapshot) return;
        view = {
          authority,
          room: sessionSnapshot.room ?? view.room,
          session,
          sessionSnapshot,
        };
        publish();
      });
      publish();
      return session;
    },
    setProvisionalRoom(room: PublicRoom) {
      if (applyProvisionalRoom(room)) publish();
    },
    detachFinishedSession(expectedSession: GameSession) {
      if (disposed || view.session !== expectedSession) return false;
      if (currentSession === null) return true;
      const sessionSnapshot = expectedSession.getSnapshot();
      if (sessionSnapshot.game?.match.status !== 'finished') return false;
      unsubscribeSession?.();
      unsubscribeSession = null;
      currentSession = null;
      currentAuthority = null;
      view = {
        ...view,
        room: sessionSnapshot.room ?? view.room,
        sessionSnapshot,
      };
      expectedSession.dispose();
      publish();
      return true;
    },
    clear() {
      if (disposed || !releaseCurrentSession()) return;
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (releaseCurrentSession()) publish();
      subscribers.clear();
    },
    getSnapshot: () => view,
    subscribe: (listener) => {
      if (disposed) return () => {};
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  };
}
