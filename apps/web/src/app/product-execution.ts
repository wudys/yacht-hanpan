import { createGameClient, type GameClient } from '@repo/game-client-sdk';

import {
  createBrowserAudioRuntime,
  type ProductAudioRuntime,
} from '@/runtime/audio/browser-audio-runtime';
import {
  type GameAudioFeedback,
  startGameAudioFeedback,
} from '@/runtime/audio/game-audio-feedback';
import { createDicePresentation, type DicePresentation } from '@/runtime/dice/dice-presentation';
import { createServerReadiness } from '@/runtime/network/server-readiness';
import type { ProductPreferences } from '@/runtime/preferences/product-preferences';
import { createProductProfile, type ProductProfile } from '@/runtime/profile/product-profile';
import { createRoomAccess, type RoomAccess } from '@/runtime/room-access/room-access';
import {
  createStoredRoomRestore,
  type StoredRoomRestore,
} from '@/runtime/room-access/stored-room-restore';
import {
  type BrowserSessionStore,
  createBrowserSessionStore,
} from '@/runtime/session/browser-session-store';
import { createGameSessionHolder, type GameSessionHolder } from '@/runtime/session/session-holder';
import { createSessionRecovery, type SessionRecovery } from '@/runtime/session/session-recovery';
import type { Telemetry } from '@/runtime/telemetry/telemetry';

export interface ProductExecution {
  readonly activity: AbortSignal;
  readonly audio: ProductAudioRuntime;
  readonly client: GameClient;
  readonly profile: ProductProfile;
  readonly store: BrowserSessionStore;
  readonly sessions: GameSessionHolder;
  readonly recovery: SessionRecovery;
  readonly feedback: GameAudioFeedback;
  readonly presentation: DicePresentation;
  readonly restore: StoredRoomRestore;
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
  preferences: ProductPreferences;
  telemetry: Telemetry;
}): ProductExecution {
  const activity = new AbortController();
  let stopped = false;
  let audio: ProductAudioRuntime | undefined;
  let sessions: GameSessionHolder | undefined;
  let recovery: SessionRecovery | undefined;
  let feedback: GameAudioFeedback | undefined;
  let presentation: DicePresentation | undefined;
  let restore: StoredRoomRestore | undefined;
  let access: RoomAccess | undefined;

  function stop() {
    if (stopped) return;
    stopped = true;
    activity.abort();
    access?.dispose();
    restore?.dispose();
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
    const store = createBrowserSessionStore({ signal: activity.signal });
    const profile = createProductProfile({
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
      requireRefreshAfterSynchronization: (reason, cause) => {
        telemetry.reportUnexpected(reason === 'SIMULATION_FAILED' ? cause : new Error(reason), {
          stage: 'replay',
          replay_reason: reason,
        });
        executionRecovery.requireRefreshAfterSynchronization();
      },
      playCue: executionAudio.playCue,
    });
    presentation = executionPresentation;
    executionPresentation.start();
    const readiness = createServerReadiness(serverUrl);
    const executionRestore = createStoredRoomRestore({
      client,
      sessions: executionSessions,
      store,
      readiness,
      onUnexpected: (error) =>
        telemetry.reportUnexpected(error, { operation: 'synchronize', stage: 'promise' }),
    });
    restore = executionRestore;
    const executionAccess = createRoomAccess({
      activity: activity.signal,
      client,
      sessions: executionSessions,
      store,
      readiness,
      restore: executionRestore,
      recovery: executionRecovery,
    });
    access = executionAccess;
    return {
      activity: activity.signal,
      audio: executionAudio,
      client,
      profile,
      store,
      sessions: executionSessions,
      recovery: executionRecovery,
      feedback: executionFeedback,
      presentation: executionPresentation,
      restore: executionRestore,
      access: executionAccess,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
