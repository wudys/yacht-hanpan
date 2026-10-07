import type { GameClient, GameSession } from '@repo/game-client-sdk';
import type { ClientError } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';

import { isPermanentAuthorityFailure } from '@/runtime/session/authority-failure';
import type { GameSessionHolder } from '@/runtime/session/game-session-holder';
import type { SessionCredentialStore } from '@/runtime/session/session-credential-store';

export type WaitingRoomSummary = Readonly<{ roomCode: string; expiresAt: number }>;
export type ExpiryCheck =
  | { status: 'stale' | 'gone' | 'matched' }
  | { status: 'waiting'; room: WaitingRoomSummary }
  | { status: 'failure'; error: ClientError };

export type Cancellation =
  | { status: 'stale' | 'cancelled' | 'matched' }
  | { status: 'failure' | 'syncFailed'; error: ClientError };

export function createWaitingOperations({
  client,
  sessions,
  sessionCredentialStore,
}: {
  client: Pick<GameClient, 'resumeRoom' | 'cancelRoom'>;
  sessions: GameSessionHolder;
  sessionCredentialStore: SessionCredentialStore;
}) {
  const current = (session: GameSession) => sessions.getSnapshot().session === session;
  return {
    async checkExpiry(signal: AbortSignal): Promise<ExpiryCheck> {
      const { authority, session } = sessions.getSnapshot();
      if (!session || !authority || !current(session)) return { status: 'stale' };
      const result = await client.resumeRoom(
        { roomId: authority.roomId, seatToken: authority.seatToken },
        { signal },
      );
      if (signal.aborted || !current(session)) return { status: 'stale' };
      if (!result.ok) {
        if (!isPermanentAuthorityFailure(result.error))
          return { status: 'failure', error: result.error };
        if (sessions.getSnapshot().sessionSnapshot?.game) return { status: 'matched' };
        sessionCredentialStore.removeRoom(authority.roomId);
        if (signal.aborted || !current(session)) return { status: 'stale' };
        if (sessions.getSnapshot().sessionSnapshot?.game) return { status: 'matched' };
        sessions.clear();
        return { status: 'gone' };
      }
      sessions.setProvisionalRoom(result.data.view.room);
      if (signal.aborted || !current(session)) return { status: 'stale' };
      if (result.data.view.room.status === 'waiting')
        return { status: 'waiting', room: result.data.view.room };
      const sync = await session.synchronize();
      if (signal.aborted || !current(session)) return { status: 'stale' };
      return sync.ok ? { status: 'matched' } : { status: 'failure', error: sync.error };
    },
    async cancel(
      signal: AbortSignal,
      onHttpResponse: (error?: ClientError) => void,
    ): Promise<Cancellation> {
      const { authority, session } = sessions.getSnapshot();
      if (!authority || !session) return { status: 'cancelled' };
      const result = await client.cancelRoom(
        {
          roomId: authority.roomId,
          seatToken: authority.seatToken,
        },
        { signal },
      );
      if (signal.aborted || !current(session)) return { status: 'stale' };
      // Report the HTTP outcome before any follow-up synchronization completes.
      onHttpResponse(result.ok ? undefined : result.error);
      if (signal.aborted || !current(session)) return { status: 'stale' };
      if (sessions.getSnapshot().sessionSnapshot?.game) return { status: 'matched' };
      if (result.ok) {
        sessionCredentialStore.removeRoom(authority.roomId);
        if (signal.aborted || !current(session)) return { status: 'stale' };
        if (sessions.getSnapshot().sessionSnapshot?.game) return { status: 'matched' };
        sessions.clear();
        return { status: 'cancelled' };
      }
      if (
        result.error.kind === 'server' &&
        result.error.error.code === PUBLIC_ERROR_CODE.ROOM_ALREADY_MATCHED
      ) {
        const sync = await session.synchronize();
        if (signal.aborted || !current(session)) return { status: 'stale' };
        return sync.ok ? { status: 'matched' } : { status: 'syncFailed', error: sync.error };
      }
      return { status: 'failure', error: result.error };
    },
  };
}
