import type { PresenceSnapshot } from '@repo/game-protocol/socket';
import { createContext, type ReactNode, useContext } from 'react';

import { useOpponentPresenceNotice } from '@/features/game/game-display-hooks';
import { GamePresence } from '@/features/game/view/board';
import { type Locale, translate } from '@/i18n';
import type { RoomPersistence } from '@/runtime/session/browser-session-store';

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
