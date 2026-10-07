import { createGameClient, type GameClient } from '@repo/game-client-sdk';

import {
  type BrowserAudioRuntime,
  createBrowserAudioRuntime,
} from '@/runtime/audio/browser-audio-runtime';
import {
  type GameAudioFeedback,
  startGameAudioFeedback,
} from '@/runtime/audio/game-audio-feedback';
import { createDicePresentation, type DicePresentation } from '@/runtime/dice/dice-presentation';
import { createServerReadiness } from '@/runtime/network/server-readiness';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';
import {
  createProfileSelectionStore,
  type ProfileSelectionStore,
} from '@/runtime/profile/profile-selection-store';
import { createRoomAccess, type RoomAccess } from '@/runtime/room-access/room-access';
import {
  createStoredRoomReentry,
  type StoredRoomReentry,
} from '@/runtime/room-access/stored-room-reentry';
import {
  createGameSessionHolder,
  type GameSessionHolder,
} from '@/runtime/session/game-session-holder';
import {
  createSessionCredentialStore,
  type SessionCredentialStore,
} from '@/runtime/session/session-credential-store';
import { createSessionRecovery, type SessionRecovery } from '@/runtime/session/session-recovery';
import type { Telemetry } from '@/runtime/telemetry/telemetry';

export interface ProductExecution {
  readonly activity: AbortSignal;
  readonly audio: BrowserAudioRuntime;
  readonly client: GameClient;
  readonly profile: ProfileSelectionStore;
  readonly sessionCredentialStore: SessionCredentialStore;
  readonly sessions: GameSessionHolder;
  readonly recovery: SessionRecovery;
  readonly feedback: GameAudioFeedback;
  readonly presentation: DicePresentation;
  readonly reentry: StoredRoomReentry;
  readonly access: RoomAccess;
  stop(): void;
}

export function createProductExecution({
  serverUrl,
  releaseId,
  preferences,
  telemetry,
}: {
  serverUrl: string;
  releaseId: string;
  preferences: PreferencesStore;
  telemetry: Telemetry;
}): ProductExecution {
  const activity = new AbortController();
  let stopped = false;
  let audio: BrowserAudioRuntime | undefined;
  let sessions: GameSessionHolder | undefined;
  let recovery: SessionRecovery | undefined;
  let feedback: GameAudioFeedback | undefined;
  let presentation: DicePresentation | undefined;
  let reentry: StoredRoomReentry | undefined;
  let access: RoomAccess | undefined;

  function stop() {
    if (stopped) return;
    stopped = true;
    activity.abort();
    access?.dispose();
    reentry?.dispose();
    feedback?.dispose();
    recovery?.dispose();
    presentation?.dispose();
    sessions?.dispose();
    void audio?.dispose();
  }

  try {
    const { bgmEnabled, sfxEnabled } = preferences.getSnapshot();
    const executionAudio = createBrowserAudioRuntime({ bgmEnabled, sfxEnabled });
    audio = executionAudio;
    const sessionCredentialStore = createSessionCredentialStore({ signal: activity.signal });
    const profile = createProfileSelectionStore({
      getItem: (key) => window.localStorage.getItem(key),
      setItem: (key, value) => window.localStorage.setItem(key, value),
    });
    const client = createGameClient({
      serverUrl,
      releaseId,
      // Defer fetch access so unsupported environments can render the Entry notice.
      fetch: (input, init) => globalThis.fetch(input, init),
    });
    const executionSessions = createGameSessionHolder(client);
    sessions = executionSessions;
    const executionRecovery = createSessionRecovery({
      sessions: executionSessions,
      onUnexpected: (error) =>
        telemetry.reportUnexpected(error, { operation: 'synchronize', stage: 'promise' }),
    });
    recovery = executionRecovery;
    executionRecovery.start();
    const executionFeedback = startGameAudioFeedback({
      audio: executionAudio,
      clock: client.clock,
      sessions: executionSessions,
      recovery: executionRecovery,
      preferences,
    });
    feedback = executionFeedback;
    const executionPresentation = createDicePresentation({
      sessions: executionSessions,
      requestSynchronization: executionRecovery.requestSynchronization,
      onUnexpected: (error) => telemetry.reportUnexpected(error, { stage: 'replay' }),
      requireRefreshAfterSynchronization: (failure) => {
        telemetry.reportUnexpected(
          failure.reason === 'SIMULATION_FAILED' ? failure.cause : new Error(failure.reason),
          {
            stage: 'replay',
            replay_reason: failure.reason,
          },
        );
        executionRecovery.requireRefreshAfterSynchronization();
      },
      playCue: executionAudio.playCue,
    });
    presentation = executionPresentation;
    executionPresentation.start();
    const readiness = createServerReadiness(serverUrl);
    const executionReentry = createStoredRoomReentry({
      client,
      sessions: executionSessions,
      sessionCredentialStore,
      readiness,
      onUnexpected: (error) =>
        telemetry.reportUnexpected(error, { operation: 'synchronize', stage: 'promise' }),
    });
    reentry = executionReentry;
    const executionAccess = createRoomAccess({
      activity: activity.signal,
      client,
      sessions: executionSessions,
      sessionCredentialStore,
      readiness,
      reentry: executionReentry,
      recovery: executionRecovery,
    });
    access = executionAccess;
    return {
      activity: activity.signal,
      audio: executionAudio,
      client,
      profile,
      sessionCredentialStore,
      sessions: executionSessions,
      recovery: executionRecovery,
      feedback: executionFeedback,
      presentation: executionPresentation,
      reentry: executionReentry,
      access: executionAccess,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
