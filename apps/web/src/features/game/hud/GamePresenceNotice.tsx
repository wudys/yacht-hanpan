import type { PresenceSnapshot } from '@repo/game-protocol/socket';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { GamePresence } from '@/features/game/view/board';
import { type Locale, translate } from '@/i18n';
import type { RoomPersistence } from '@/runtime/session/session-credential-store';

const GamePresenceMessage = createContext<string | undefined>(undefined);

export function GamePresenceProvider({
  identity,
  status,
  reconnectDeadlineAt,
  persistence,
  locale,
  children,
}: Readonly<{
  identity: object | null;
  status: PresenceSnapshot['seats'][number]['status'] | null;
  reconnectDeadlineAt: Extract<
    PresenceSnapshot['seats'][number],
    { status: 'disconnected' }
  >['reconnectDeadlineAt'];
  persistence: RoomPersistence;
  locale: Locale;
  children: ReactNode;
}>) {
  const presence =
    status === null ? null : status === 'connected' ? { status } : { status, reconnectDeadlineAt };
  const notice = useOpponentPresenceNotice(presence, identity);
  const message =
    persistence === 'memoryOnly' && notice !== 'disconnected'
      ? translate(locale, 'session.storageFailure')
      : notice === null
        ? undefined
        : translate(
            locale,
            notice === 'disconnected' ? 'game.opponentDisconnected' : 'game.opponentReconnected',
          );
  return <GamePresenceMessage.Provider value={message}>{children}</GamePresenceMessage.Provider>;
}

export function GamePresenceNotice() {
  const message = useContext(GamePresenceMessage);
  return <GamePresence message={message} />;
}

function useOpponentPresenceNotice(
  presence: PresenceSnapshot['seats'][number] | null,
  identity: object | null,
): 'disconnected' | 'reconnected' | null {
  // A null deadline means the opponent has not established an in-game connection yet.
  const connection =
    presence?.status === 'disconnected' && presence.reconnectDeadlineAt === null
      ? null
      : (presence?.status ?? null);
  const previousRef = useRef<{ identity: object | null; connection: typeof connection } | null>(
    null,
  );
  const [notice, setNotice] = useState<{
    identity: object | null;
    value: 'disconnected' | 'reconnected' | null;
  } | null>(null);

  useEffect(() => {
    const previous =
      previousRef.current?.identity === identity ? previousRef.current.connection : null;
    previousRef.current = { identity, connection };
    if (connection === 'disconnected') {
      setNotice({ identity, value: 'disconnected' });
      return;
    }
    if (connection !== 'connected' || previous !== 'disconnected') {
      setNotice({ identity, value: null });
      return;
    }

    setNotice({ identity, value: 'reconnected' });
    const timer = globalThis.setTimeout(() => setNotice({ identity, value: null }), 2_000);
    return () => globalThis.clearTimeout(timer);
  }, [connection, identity]);

  return notice?.identity === identity ? notice.value : null;
}
