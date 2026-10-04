import type { ServerClock } from '@repo/game-client-sdk';
import type { PresenceSnapshot } from '@repo/game-protocol/socket';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

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

function useDeadlineSubscription(deadlineAt: number | null) {
  return useCallback(
    (onClockSample: () => void) => {
      if (deadlineAt === null) return () => {};
      const interval = window.setInterval(onClockSample, 250);
      return () => window.clearInterval(interval);
    },
    [deadlineAt],
  );
}

function deadlineSeconds(
  clock: Pick<ServerClock, 'now'>,
  deadlineAt: number | null,
): number | null {
  const now = clock.now();
  return now === null || deadlineAt === null
    ? null
    : Math.max(0, Math.ceil((deadlineAt - now) / 1_000));
}

export function useDeadlineSeconds(
  clock: Pick<ServerClock, 'now'>,
  deadlineAt: number | null,
): number | null {
  const subscribe = useDeadlineSubscription(deadlineAt);
  const getSnapshot = useCallback(() => deadlineSeconds(clock, deadlineAt), [clock, deadlineAt]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useDeadlineReadiness(
  clock: Pick<ServerClock, 'now'>,
  deadlineAt: number | null,
): Readonly<{ ready: boolean; recheck: () => void }> {
  const subscribeToClock = useDeadlineSubscription(deadlineAt);
  const observerRef = useRef<(() => void) | null>(null);
  const subscribe = useCallback(
    (onClockSample: () => void) => {
      observerRef.current = onClockSample;
      const unsubscribe = subscribeToClock(onClockSample);
      return () => {
        observerRef.current = null;
        unsubscribe();
      };
    },
    [subscribeToClock],
  );
  const recheck = useCallback(() => observerRef.current?.(), []);
  const getSnapshot = useCallback(() => {
    const seconds = deadlineSeconds(clock, deadlineAt);
    return seconds !== null && seconds > 0;
  }, [clock, deadlineAt]);
  const ready = useSyncExternalStore(subscribe, getSnapshot);
  return { ready, recheck };
}

export function useDelayedRollSpinner(pending: boolean, identity: object | null): boolean {
  const [visibleIdentity, setVisibleIdentity] = useState<object | null>(null);
  useEffect(() => {
    setVisibleIdentity(null);
    if (!pending || identity === null) return;
    const timeout = window.setTimeout(() => setVisibleIdentity(identity), 600);
    return () => window.clearTimeout(timeout);
  }, [pending, identity]);
  return pending && identity !== null && visibleIdentity === identity;
}
