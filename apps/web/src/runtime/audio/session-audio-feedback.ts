import type { GameSession, ServerClock } from '@repo/game-client-sdk';
import type { CommandResult } from '@repo/game-client-sdk/session';

import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { AUDIO_CUE } from '@/runtime/audio/cue-runtime';
import { createTurnWarning } from '@/runtime/audio/turn-warning';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';
import type { GameSessionHolder } from '@/runtime/session/game-session-holder';
import type { SessionRecovery } from '@/runtime/session/session-recovery';

export interface HoldReceiptObservation {
  session: GameSession;
  result: Promise<CommandResult>;
  cue: (typeof AUDIO_CUE)['HOLD' | 'RELEASE'];
  syncRevision: number | undefined;
}
export interface SessionAudioFeedback {
  observeHoldReceipt: (command: HoldReceiptObservation) => void;
  setSurfaceExposed: (exposed: boolean) => void;
  dispose: () => void;
}

export function startSessionAudioFeedback(options: {
  audio: Pick<BrowserAudioRuntime, 'playCue' | 'stopCue'>;
  clock: Pick<ServerClock, 'now'>;
  sessions: Pick<GameSessionHolder, 'getSnapshot' | 'subscribe'>;
  recovery: Pick<SessionRecovery, 'getSnapshot' | 'subscribe'>;
  preferences: Pick<PreferencesStore, 'getSnapshot' | 'subscribe'>;
}): SessionAudioFeedback {
  const { audio, clock, sessions, recovery, preferences } = options;
  const warning = createTurnWarning(
    () => audio.playCue(AUDIO_CUE.TIMER_WARNING),
    () => audio.stopCue(AUDIO_CUE.TIMER_WARNING),
  );
  let previousSession: GameSession | null = null;
  let surfaceExposed = true;
  let disposed = false;
  const consumed = new Set<string>();
  const pending = new Set<HoldReceiptObservation>();
  function update() {
    if (disposed) return;
    const current = sessions.getSnapshot(),
      game = current.sessionSnapshot?.game;
    if (current.session !== previousSession) {
      warning.update(null, null, false);
      previousSession = current.session;
      consumed.clear();
    }
    for (const entry of pending) {
      if (
        current.session !== entry.session ||
        current.sessionSnapshot?.syncRevision !== entry.syncRevision ||
        recovery.getSnapshot().status !== 'idle' ||
        !surfaceExposed ||
        !preferences.getSnapshot().sfxEnabled ||
        document.hidden
      ) {
        pending.delete(entry);
      }
    }
    const turn = game?.match.status === 'playing' ? game.match.currentTurn : null;
    const now = clock.now();
    const seconds =
      turn && now !== null ? Math.max(0, Math.ceil((turn.deadlineAt - now) / 1000)) : null;
    const identity =
      turn && current.authority ? `${current.authority.roomId}:${turn.turnId}` : null;
    const allowed = Boolean(
      turn &&
      current.authority?.seatIndex === turn.seatIndex &&
      recovery.getSnapshot().status === 'idle' &&
      preferences.getSnapshot().sfxEnabled &&
      surfaceExposed &&
      !document.hidden,
    );
    warning.update(identity, seconds, allowed);
  }
  const unsubscribers = [
    sessions.subscribe(update),
    recovery.subscribe(update),
    preferences.subscribe(update),
  ];
  document.addEventListener('visibilitychange', update);
  const interval = window.setInterval(update, 250);
  update();
  return {
    setSurfaceExposed(exposed: boolean) {
      if (disposed || surfaceExposed === exposed) return;
      surfaceExposed = exposed;
      update();
    },
    observeHoldReceipt(command: HoldReceiptObservation) {
      const entry = { ...command };
      if (!disposed) {
        pending.add(entry);
        update();
      }
      void command.result.then(
        (result) => {
          if (!pending.has(entry)) return;
          if (!result.ok) {
            pending.delete(entry);
            return;
          }
          update();
          if (!pending.delete(entry) || consumed.has(result.actionId)) return;
          consumed.add(result.actionId);
          audio.playCue(entry.cue);
        },
        () => pending.delete(entry),
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      pending.clear();
      consumed.clear();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
      audio.stopCue(AUDIO_CUE.TIMER_WARNING);
    },
  };
}
