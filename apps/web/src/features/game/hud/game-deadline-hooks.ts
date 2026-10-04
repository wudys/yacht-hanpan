import type { ServerClock } from '@repo/game-client-sdk';
import { useCallback, useRef, useSyncExternalStore } from 'react';

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
