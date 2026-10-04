import type { ClientError } from '@repo/game-client-sdk';

import type { StoredRoomReentry } from '@/runtime/room-access/stored-room-reentry';
import type { GameSessionHolder } from '@/runtime/session/game-session-holder';
import type { RecoveryAttemptEvent } from '@/runtime/session/recovery-attempt';
import type { SessionRecovery } from '@/runtime/session/session-recovery';
import { reportClientFailure } from '@/runtime/telemetry/error-policy';
import { clientFailureFields, type Telemetry } from '@/runtime/telemetry/telemetry';

export function observeSessionTelemetry(options: {
  telemetry: Telemetry;
  sessions: GameSessionHolder;
  recovery: SessionRecovery;
  reentry: StoredRoomReentry;
}): () => void {
  const { telemetry, sessions, recovery, reentry } = options;
  const seen = new WeakMap<
    NonNullable<ReturnType<GameSessionHolder['getSnapshot']>['session']>,
    { entry: 'new' | 'resumed' | null; finished: boolean; error: ClientError | null }
  >();
  const observeSession = () => {
    const { session, sessionSnapshot, authority } = sessions.getSnapshot();
    if (!session || !sessionSnapshot) return;
    let state = seen.get(session);
    if (!state) {
      state = { entry: null, finished: false, error: null };
      seen.set(session, state);
    }
    const { error } = sessionSnapshot;
    if (error !== state.error) {
      // Reentry reports its result; remember the same snapshot error through handoff.
      state.error = error;
      if (error && reentry.getSnapshot().status === 'idle')
        reportClientFailure(telemetry, error, {
          operation: 'synchronize',
          stage: 'snapshot',
        });
    }
    const match = sessionSnapshot.game?.match;
    if (!match) return;
    if (match.status === 'playing' && state.entry === null) {
      state.entry = reentry.getSnapshot().status === 'idle' ? 'new' : 'resumed';
      telemetry.trackEvent({
        name: 'play_started',
        entry: state.entry,
      });
    }
    if (match.status === 'finished' && state.entry !== null && !state.finished) {
      state.finished = true;
      telemetry.trackEvent({
        name: 'play_finished',
        entry: state.entry,
        reason:
          match.result.reason === 'scoresCompleted'
            ? 'completed'
            : match.result.reason === 'explicitForfeit'
              ? 'forfeit'
              : match.result.reason === 'timeoutLimit'
                ? 'timeout'
                : 'other',
        outcome:
          match.result.winnerSeatIndex === null
            ? 'draw'
            : match.result.winnerSeatIndex === authority.seatIndex
              ? 'win'
              : 'loss',
      });
    }
  };
  const observeAttempt = (operation: 'connection' | 'reentry') => {
    let collected = false;
    return (event: RecoveryAttemptEvent): void => {
      if (event.phase === 'started') {
        // Reentry owns its whole reconnect/sync episode, including connection changes.
        collected = operation === 'reentry' || reentry.getSnapshot().status === 'idle';
        if (collected) telemetry.trackEvent({ name: 'recovery_started', operation });
        return;
      }
      if (!collected) return;
      collected = false;
      if (operation === 'reentry' && event.error)
        reportClientFailure(telemetry, event.error, {
          operation: 'synchronize',
          stage: 'response',
        });
      telemetry.trackEvent({
        name: 'recovery_result',
        operation,
        outcome: event.outcome,
        duration_ms: Math.max(0, Math.round(event.durationMs)),
        ...(event.outcome === 'failure' ? clientFailureFields(event.error) : {}),
      });
    };
  };
  const stops = [
    sessions.subscribe(observeSession),
    recovery.subscribeAttempt(observeAttempt('connection')),
    reentry.subscribeAttempt(observeAttempt('reentry')),
  ];
  observeSession();
  return () => {
    for (const stop of stops) stop();
  };
}
