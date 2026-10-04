import type { GameSession } from '@repo/game-client-sdk';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { APP_SCREEN_PATH } from '@/app/screen-paths';
import type { BrowserSessionStore } from '@/runtime/session/browser-session-store';
import type {
  GameSessionHolder,
  GameSessionHolderSnapshot,
} from '@/runtime/session/session-holder';

export function useGameResultLifecycle(
  sessions: GameSessionHolder,
  store: BrowserSessionStore,
  holderSnapshot: GameSessionHolderSnapshot,
  onIntent: () => void,
  commandPending: boolean,
): () => void {
  const navigate = useNavigate({ from: APP_SCREEN_PATH.GAME });
  const terminalActionPendingRef = useRef(false);
  const finishedSessionRef = useRef<GameSession | null>(null);

  const finished = holderSnapshot.sessionSnapshot?.game?.match.status === 'finished';
  useEffect(() => {
    const current = sessions.getSnapshot();
    if (
      !finished ||
      current.authority === null ||
      current.sessionSnapshot.game?.match.status !== 'finished' ||
      current.session !== holderSnapshot.session
    ) {
      return;
    }
    if (finishedSessionRef.current !== current.session) {
      finishedSessionRef.current = current.session;
      store.removeRoom(current.authority.roomId);
    }
    // Result can render immediately; the existing bounded command must still deliver its receipt.
    if (!commandPending) sessions.detachFinishedSession(current.session);
  }, [commandPending, finished, holderSnapshot, sessions, store]);

  const returnToLobby = (): void => {
    if (terminalActionPendingRef.current) return;
    terminalActionPendingRef.current = true;
    onIntent();
    const current = sessions.getSnapshot();
    if (current.authority === null) {
      sessions.clear();
      void navigate({ to: APP_SCREEN_PATH.LOBBY });
      return;
    }
    if (finishedSessionRef.current !== current.session) store.removeRoom(current.authority.roomId);
    if (sessions.getSnapshot().session !== current.session) {
      terminalActionPendingRef.current = false;
      return;
    }
    sessions.clear();
    void navigate({ to: APP_SCREEN_PATH.LOBBY });
  };

  return returnToLobby;
}
