import '@/features/lobby/lobby-screen.css';

import { requireGameAsset } from '@repo/game-assets';
import { type CharacterId, resolveCharacterImageAssetId } from '@repo/game-assets/characters';
import type { ServerClock } from '@repo/game-client-sdk';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { PendingIndicator } from '@/features/lobby/layer/LobbyLayer';
import { LobbyScreenLayer } from '@/features/lobby/layer/LobbyScreenLayer';
import { LobbyView } from '@/features/lobby/ui/LobbyView';
import { useLobbyFlow } from '@/features/lobby/use-lobby-flow';
import { useRoomCodeClipboard } from '@/features/lobby/use-room-code-clipboard';
import { type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { AUDIO_CUE } from '@/runtime/audio/cue-runtime';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';
import type { ProfileSelectionStore } from '@/runtime/profile/profile-selection-store';
import type { RoomAccess } from '@/runtime/room-access/room-access';
import { useScreenTelemetry } from '@/runtime/telemetry/TelemetryContext';

type LobbyScreenProps = Readonly<{
  audio: BrowserAudioRuntime;
  locale: Locale;
  activity: AbortSignal;
  access: RoomAccess;
  clock: Pick<ServerClock, 'now'>;
  profile: ProfileSelectionStore;
  preferences: PreferencesStore;
}>;

export default function LobbyScreen({
  audio,
  locale,
  activity,
  access,
  clock,
  profile: productProfile,
  preferences,
}: LobbyScreenProps) {
  useScreenTelemetry('lobby');
  const { selection: profile, storageFailed: profileStorageFailed } = useSyncExternalStore(
    productProfile.subscribe,
    productProfile.getSnapshot,
  );
  const { characterId, variant } = profile;
  const [browsedVariant, setBrowsedVariant] = useState(variant);
  useEffect(() => {
    void audio.setScene('lobby');
    void audio.prefetchScenes(['game', 'result']).catch(() => undefined);
  }, [audio]);

  const flow = useLobbyFlow({
    activity,
    access,
    clock,
    profile: productProfile,
    onIntent: () => audio.playCue(AUDIO_CUE.CLICK),
  });
  const { screenState, waitingRoom, reentryState, showDelayedProgress, readinessOperation } = flow;
  const reentryBlocking = reentryState.status !== 'idle';
  const clipboard = useRoomCodeClipboard(screenState, waitingRoom, () =>
    audio.playCue(AUDIO_CUE.SUCCESS),
  );

  const selectCharacter = (nextCharacterId: CharacterId) => {
    const selection = { characterId: nextCharacterId, variant: browsedVariant };
    if (productProfile.setSelection(selection)) audio.playCue(AUDIO_CUE.SELECT);
  };

  const createProgress =
    screenState === 'creating' && showDelayedProgress ? (
      <PendingIndicator
        label={translate(
          locale,
          readinessOperation === 'create' ? 'lobby.serverPreparing' : 'lobby.createPending',
        )}
      />
    ) : undefined;
  return (
    <div
      className='web-lobby-scene'
      data-lobby-view={screenState}
      data-reentry-state={reentryState.status}
      data-screen='lobby'
      data-testid='lobby-screen'
    >
      <h1 className='web-lobby-scene__sr-only'>{translate(locale, 'lobby.title')}</h1>
      <LobbyView
        hideRoomActions={
          !reentryBlocking && ['joinRoom', 'joining', 'waiting', 'matching'].includes(screenState)
        }
        profile={{
          imageUrl: requireGameAsset(resolveCharacterImageAssetId(characterId, variant)).url,
          alt: characterId,
        }}
        labels={{
          editProfile: translate(locale, 'lobby.profile'),
          settings: translate(locale, 'lobby.settings'),
          createRoom: translate(locale, 'lobby.createRoom'),
          joinRoom: translate(locale, 'lobby.joinRoom'),
        }}
        interactionLocked={reentryBlocking || screenState !== 'home'}
        createProgress={createProgress}
        onCreateRoom={flow.createRoom}
        onJoinRoom={flow.openJoinRoom}
        onEditProfile={() => {
          setBrowsedVariant(variant);
          flow.openProfile();
        }}
        onOpenSettings={flow.openSettings}
      />

      <LobbyScreenLayer
        flow={flow}
        locale={locale}
        audio={audio}
        preferences={preferences}
        clipboard={clipboard}
        profile={{
          variant: browsedVariant,
          storageFailed: profileStorageFailed,
          selectedCharacterId: variant === browsedVariant ? characterId : null,
          onStyleChange: (next) => {
            if (next !== browsedVariant) {
              setBrowsedVariant(next);
              audio.playCue(AUDIO_CUE.SELECT);
            }
          },
          onSelect: selectCharacter,
        }}
      />
    </div>
  );
}
