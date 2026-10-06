import type { ServerClock } from '@repo/game-client-sdk';
import { useCallback, useRef, useSyncExternalStore } from 'react';

function useDeadlineSubscription(
  clock: Pick<ServerClock, 'now'>,
  deadlineAt: number | null,
  startedAt: number | null,
) {
  return useCallback(
    (onClockSample: () => void) => {
      if (deadlineAt === null) return () => {};
      let boundary: number | undefined;
      const sample = () => {
        window.clearTimeout(boundary);
        onClockSample();
        const now = clock.now();
        if (now === null) return;
        const next = startedAt !== null && now < startedAt ? startedAt : deadlineAt;
        if (next > now) boundary = window.setTimeout(sample, next - now);
      };
      sample();
      const interval = window.setInterval(sample, 250);
      return () => {
        window.clearInterval(interval);
        window.clearTimeout(boundary);
      };
    },
    [clock, deadlineAt, startedAt],
  );
}

function deadlineSeconds(
  clock: Pick<ServerClock, 'now'>,
  deadlineAt: number | null,
  startedAt: number | null,
): number | null {
  const now = clock.now();
  return now === null || deadlineAt === null
    ? null
    : Math.max(0, Math.ceil((deadlineAt - Math.max(now, startedAt ?? now)) / 1_000));
}

function turnDeadlineStatus(
  now: number | null,
  deadlineAt: number | null,
  startedAt: number | null,
): 'unavailable' | 'waiting' | 'active' {
  if (now === null || deadlineAt === null || now >= deadlineAt) return 'unavailable';
  return startedAt !== null && now < startedAt ? 'waiting' : 'active';
}

export function isTurnReady(
  clock: Pick<ServerClock, 'now'>,
  deadlineAt: number | null,
  startedAt: number | null,
): boolean {
  return turnDeadlineStatus(clock.now(), deadlineAt, startedAt) === 'active';
}

export function useDeadlineSeconds(
  clock: Pick<ServerClock, 'now'>,
  deadlineAt: number | null,
  startedAt: number | null = null,
): number | null {
  const subscribe = useDeadlineSubscription(clock, deadlineAt, startedAt);
  const getSnapshot = useCallback(
    () => deadlineSeconds(clock, deadlineAt, startedAt),
    [clock, deadlineAt, startedAt],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useDeadlineReadiness(
  clock: Pick<ServerClock, 'now'>,
  deadlineAt: number | null,
  startedAt: number | null = null,
): Readonly<{ ready: boolean; turnReady: boolean; recheck: () => void }> {
  const subscribeToClock = useDeadlineSubscription(clock, deadlineAt, startedAt);
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
  const getSnapshot = useCallback(
    () => turnDeadlineStatus(clock.now(), deadlineAt, startedAt),
    [clock, deadlineAt, startedAt],
  );
  const status = useSyncExternalStore(subscribe, getSnapshot);
  return { ready: status !== 'unavailable', turnReady: status === 'active', recheck };
}
