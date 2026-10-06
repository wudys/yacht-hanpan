import type { ServerClock } from '@repo/game-client-sdk';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  advanceTurnFeedback,
  createTurnFeedbackState,
  nextFeedbackBoundary,
  type TurnFeedbackInput,
  type TurnFeedbackState,
} from '@/features/game/turn-feedback-state';

export type TurnFeedbackSnapshot = Pick<
  TurnFeedbackState,
  'session' | 'record' | 'turnCue' | 'tabRequest'
>;

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

const isHidden = () => document.visibilityState === 'hidden';

/** A local display lifetime; accepted SDK state and server time remain authoritative. */
export function useTurnFeedback(
  options: Omit<TurnFeedbackInput, 'now' | 'serverNow'>,
  clock: Pick<ServerClock, 'now'>,
  onRecordStart: () => void,
): TurnFeedbackSnapshot {
  const hidden = useSyncExternalStore(subscribeVisibility, isHidden);
  const [state, setState] = useState(createTurnFeedbackState);
  const input = {
    ...options,
    suspended: options.suspended || hidden,
    now: performance.now(),
    serverNow: clock.now(),
  };
  const next = advanceTurnFeedback(state, input);
  // Project accepted facts during this render so a final score cannot flash Result first.
  if (next !== state) setState(next);

  useEffect(() => {
    const boundary = nextFeedbackBoundary(next);
    if (boundary === null) return;
    let timer: number;
    const schedule = () => {
      // Round up the remaining milliseconds so scheduling cannot truncate the boundary.
      timer = window.setTimeout(
        () => {
          const now = performance.now();
          if (now < boundary) {
            // An early callback must retain a wakeup even when the state is unchanged.
            schedule();
            return;
          }
          setState((current) =>
            advanceTurnFeedback(current, {
              ...options,
              suspended: options.suspended || hidden,
              now,
              serverNow: clock.now(),
            }),
          );
        },
        Math.max(1, Math.ceil(boundary - performance.now())),
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [clock, hidden, next, options]);

  const consumedSound = useRef<Readonly<{ session: object | null; version: number }> | null>(null);
  const { record } = next;
  useEffect(() => {
    if (record === null) return;
    if (
      consumedSound.current?.session === next.session &&
      consumedSound.current.version === record.record.stateVersion
    )
      return;
    consumedSound.current = { session: next.session, version: record.record.stateVersion };
    if (record.visible && !isHidden()) onRecordStart();
  }, [next.session, onRecordStart, record]);

  return {
    session: next.session,
    record: next.record,
    turnCue: next.turnCue,
    tabRequest: next.tabRequest,
  };
}
