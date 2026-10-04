import type { ServerClock } from '@repo/game-client-sdk';
import type { PresenceSnapshot } from '@repo/game-protocol/socket';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import type { PendingCommandKind } from '@/features/game/use-game-commands';

export function useViewerTurnSummaryEmphasis(
  identity: string | null,
  boardVisible: boolean,
): boolean {
  const consumedIdentityRef = useRef<string | null>(null);
  const [emphasized, setEmphasized] = useState(false);

  useEffect(() => {
    if (!boardVisible || identity === null) {
      setEmphasized(false);
      return undefined;
    }
    if (consumedIdentityRef.current !== identity) {
      consumedIdentityRef.current = identity;
      setEmphasized(true);
    }

    const timer = globalThis.setTimeout(() => setEmphasized(false), 300);
    return () => globalThis.clearTimeout(timer);
  }, [boardVisible, identity]);

  return emphasized;
}

export function useOpponentPresenceNotice(
  presence: PresenceSnapshot['seats'][number] | null,
): 'disconnected' | 'reconnected' | null {
  // A null deadline means the opponent has not established an in-game connection yet.
  const connection =
    presence?.status === 'disconnected' && presence.reconnectDeadlineAt === null
      ? null
      : (presence?.status ?? null);
  const previousRef = useRef<typeof connection>(null);
  const [notice, setNotice] = useState<'disconnected' | 'reconnected' | null>(null);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = connection;
    if (connection === 'disconnected') {
      setNotice('disconnected');
      return;
    }
    if (connection !== 'connected' || previous !== 'disconnected') {
      setNotice(null);
      return;
    }

    setNotice('reconnected');
    const timer = globalThis.setTimeout(() => setNotice(null), 2_000);
    return () => globalThis.clearTimeout(timer);
  }, [connection]);

  return notice;
}

export function useDeadlineSeconds(
  clock: Pick<ServerClock, 'now'>,
  deadlineAt: number | null,
): number | null {
  const subscribe = useCallback(
    (onClockSample: () => void) => {
      if (deadlineAt === null) return () => {};
      const interval = window.setInterval(onClockSample, 250);
      return () => window.clearInterval(interval);
    },
    [deadlineAt],
  );
  const getSnapshot = useCallback(() => {
    const now = clock.now();
    return now === null || deadlineAt === null
      ? null
      : Math.max(0, Math.ceil((deadlineAt - now) / 1_000));
  }, [clock, deadlineAt]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useDelayedRollProgress(pendingCommand: PendingCommandKind | null): ReactNode {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (pendingCommand !== 'roll') {
      setVisible(false);
      return;
    }
    const timeout = window.setTimeout(() => setVisible(true), 600);
    return () => window.clearTimeout(timeout);
  }, [pendingCommand]);
  return pendingCommand === 'roll' && visible ? <span role='status'>…</span> : undefined;
}
