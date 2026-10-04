import '@/features/lobby/lobby-screen.css';

import { requireGameAsset } from '@repo/game-assets';
import { type CharacterId, resolveCharacterImageAssetId } from '@repo/game-assets/characters';
import type { ServerClock } from '@repo/game-client-sdk';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { JoinRoomLayer } from '@/features/lobby/layer/JoinRoomLayer';
import { LobbyLayer, LobbyNoticeLayer, PendingIndicator } from '@/features/lobby/layer/LobbyLayer';
import { ProfileLayer } from '@/features/lobby/layer/ProfileLayer';
import { type CopyStatus, WaitingRoomLayer } from '@/features/lobby/layer/WaitingRoomLayer';
import { lobbyError, lobbyErrorKey } from '@/features/lobby/lobby-errors';
import { useLobbyAdmission } from '@/features/lobby/use-lobby-admission';
import { LobbyView } from '@/features/lobby/view/LobbyView';
import { SettingsLayer } from '@/features/settings/SettingsLayer';
import { type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { PRODUCT_CUE } from '@/runtime/audio/product-cues';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';
import type { ProfileSelectionStore } from '@/runtime/profile/profile-selection-store';
import type { RoomAccess } from '@/runtime/room-access/room-access';
import { useScreenTelemetry } from '@/runtime/telemetry/TelemetryContext';
import { Button } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';
import { ColorCycleDiceLoader } from '@/ui/status';

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
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyAttemptRef = useRef(0);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle');

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

  const {
    view,
    waitingRoom,
    error,
    joinCode,
    openProfile,
    closeProfile,
    openSettings,
    closeSettings,
    openJoinRoom,
    closeJoinRoom,
    changeJoinCode,
    focusJoinCode,
    dismissNotice,
    createRoom,
    joinRoom,
    cancelWaiting,
    readinessOperation,
    showDelayedProgress,
    remainingSeconds,
    rateLimited,
    restoreView,
    recoveryPhase,
    confirmAuthorityFailure,
  } = useLobbyAdmission({
    activity,
    access,
    clock,
    profile: productProfile,
    onIntent: () => audio.playCue(PRODUCT_CUE.CLICK),
  });
  const reentryBlocking = restoreView.status !== 'idle';
  const waitingRecovery =
    view === 'waiting' &&
    !reentryBlocking &&
    (recoveryPhase === 'reconnecting' || recoveryPhase === 'synchronizing');

  useEffect(() => {
    copyAttemptRef.current += 1;
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = null;
    }
    setCopyStatus('idle');
    return () => {
      copyAttemptRef.current += 1;
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, [view, waitingRoom?.expiresAt, waitingRoom?.roomCode]);

  const click = () => audio.playCue(PRODUCT_CUE.CLICK);
  const copyRoomCode = async () => {
    if (!waitingRoom || view !== 'waiting') return;
    const attempt = ++copyAttemptRef.current;
    try {
      await navigator.clipboard.writeText(waitingRoom.roomCode);
      if (copyAttemptRef.current !== attempt) return;
      setCopyStatus('copied');
      audio.playCue(PRODUCT_CUE.SUCCESS);
    } catch {
      if (copyAttemptRef.current !== attempt) return;
      setCopyStatus('failed');
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      if (copyAttemptRef.current !== attempt) return;
      copyTimerRef.current = null;
      setCopyStatus('idle');
    }, 1_200);
  };

  const selectCharacter = (nextCharacterId: CharacterId) => {
    const selection = { characterId: nextCharacterId, variant: browsedVariant };
    if (productProfile.setSelection(selection)) audio.playCue(PRODUCT_CUE.SELECT);
  };

  const createProgress =
    view === 'creating' && showDelayedProgress ? (
      <PendingIndicator
        label={translate(
          locale,
          readinessOperation === 'create' ? 'lobby.serverPreparing' : 'lobby.createPending',
        )}
      />
    ) : undefined;
  const reentryProgressLabel =
    view === 'checkingExpiry' || restoreView.status === 'checking'
      ? translate(locale, 'lobby.reentryChecking')
      : restoreView.status === 'synchronizing' || restoreView.status === 'playing'
        ? translate(locale, 'lobby.reentrySynchronizing')
        : translate(locale, 'lobby.reentryConnecting');
  const reentryProgress =
    restoreView.status === 'checking' ||
    restoreView.status === 'connecting' ||
    restoreView.status === 'synchronizing' ||
    restoreView.status === 'waiting' ||
    restoreView.status === 'playing';

  return (
    <div
      className='web-lobby-scene'
      data-lobby-view={view}
      data-reentry-state={restoreView.status}
      data-screen='lobby'
      data-testid='lobby-screen'
    >
      <h1 className='web-lobby-scene__sr-only'>{translate(locale, 'lobby.title')}</h1>
      <LobbyView
        hideRoomActions={
          !reentryBlocking && ['joinRoom', 'joining', 'waiting', 'matching'].includes(view)
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
        interactionLocked={reentryBlocking || view !== 'home'}
        createProgress={createProgress}
        onCreateRoom={() => void createRoom()}
        onJoinRoom={openJoinRoom}
        onEditProfile={() => {
          setBrowsedVariant(variant);
          openProfile();
        }}
        onOpenSettings={openSettings}
      />

      {reentryProgress || view === 'checkingExpiry' ? (
        <LobbyLayer>
          <ScrollablePanel className='web-lobby-surface' title={translate(locale, 'lobby.resume')}>
            <div
              className='web-lobby-reentry'
              data-reentry-state={restoreView.status}
              role='status'
            >
              <ColorCycleDiceLoader />
              <p>{reentryProgressLabel}</p>
            </div>
          </ScrollablePanel>
        </LobbyLayer>
      ) : null}

      {restoreView.status === 'permanentFailure' ? (
        <LobbyNoticeLayer
          title={translate(locale, 'lobby.reentryFailedTitle')}
          actions={
            <Button
              label={translate(locale, 'common.confirm')}
              onClick={() => {
                click();
                confirmAuthorityFailure();
              }}
            />
          }
        >
          <p>
            {restoreView.error.kind === 'server' &&
            restoreView.error.error.code === PUBLIC_ERROR_CODE.ROOM_NOT_FOUND
              ? translate(locale, 'error.gameNotFound')
              : translate(locale, lobbyErrorKey(lobbyError(restoreView.error)))}
          </p>
        </LobbyNoticeLayer>
      ) : null}

      {restoreView.status === 'refreshRequired' ? (
        <LobbyNoticeLayer
          title={translate(locale, 'lobby.reentryFailedTitle')}
          actions={
            <Button
              label={translate(locale, 'common.refresh')}
              onClick={() => window.location.reload()}
            />
          }
        >
          <p>
            {translate(
              locale,
              restoreView.reason === 'storage'
                ? 'session.storageUnavailable'
                : 'lobby.reentryRefresh',
            )}
          </p>
        </LobbyNoticeLayer>
      ) : null}

      {!reentryBlocking && view === 'profile' ? (
        <ProfileLayer
          locale={locale}
          variant={browsedVariant}
          storageFailed={profileStorageFailed}
          selectedCharacterId={variant === browsedVariant ? characterId : null}
          onClose={closeProfile}
          onStyleChange={(next) => {
            if (next !== browsedVariant) {
              setBrowsedVariant(next);
              audio.playCue(PRODUCT_CUE.SELECT);
            }
          }}
          onSelect={selectCharacter}
        />
      ) : null}

      {!reentryBlocking && view === 'settings' ? (
        <LobbyLayer>
          <SettingsLayer audio={audio} preferences={preferences} onClose={closeSettings} />
        </LobbyLayer>
      ) : null}

      {!reentryBlocking && (view === 'joinRoom' || view === 'joining') ? (
        <JoinRoomLayer
          locale={locale}
          code={joinCode}
          joining={view === 'joining'}
          rateLimited={rateLimited}
          showDelayedProgress={showDelayedProgress}
          preparingServer={readinessOperation === 'join'}
          error={error}
          onClose={closeJoinRoom}
          onJoin={() => void joinRoom()}
          onCodeChange={changeJoinCode}
          onCodeFocus={focusJoinCode}
        />
      ) : null}

      {!reentryBlocking && (view === 'waiting' || view === 'matching') ? (
        <WaitingRoomLayer
          locale={locale}
          waitingRoom={waitingRoom}
          matching={view === 'matching'}
          recovery={
            waitingRecovery
              ? recoveryPhase === 'synchronizing'
                ? 'synchronizing'
                : 'reconnecting'
              : 'none'
          }
          remainingSeconds={remainingSeconds}
          copyStatus={copyStatus}
          onCancel={() => void cancelWaiting()}
          onCopy={() => void copyRoomCode()}
        />
      ) : null}

      {!reentryBlocking && view === 'cancelFailed' ? (
        <LobbyNoticeLayer
          title={translate(locale, 'lobby.cancelFailedTitle')}
          actions={
            <Button
              label={translate(locale, 'common.retry')}
              onClick={() => void cancelWaiting()}
            />
          }
        >
          <p>{translate(locale, 'lobby.cancelFailed')}</p>
        </LobbyNoticeLayer>
      ) : null}

      {!reentryBlocking && view === 'createFailed' ? (
        <LobbyNoticeLayer
          title={translate(locale, 'lobby.createFailedTitle')}
          actions={<Button label={translate(locale, 'common.close')} onClick={dismissNotice} />}
        >
          {error ? <p>{translate(locale, lobbyErrorKey(error))}</p> : null}
        </LobbyNoticeLayer>
      ) : null}

      {!reentryBlocking && view === 'connectionFailed' ? (
        <LobbyNoticeLayer
          title={translate(locale, 'lobby.connectionFailedTitle')}
          actions={
            <Button
              label={translate(locale, 'common.refresh')}
              onClick={() => window.location.reload()}
            />
          }
        >
          {error ? <p>{translate(locale, lobbyErrorKey(error))}</p> : null}
        </LobbyNoticeLayer>
      ) : null}

      {!reentryBlocking && (view === 'expired' || view === 'notice' || view === 'createNotice') ? (
        <LobbyNoticeLayer
          title={translate(locale, 'common.noticeTitle')}
          actions={<Button label={translate(locale, 'common.confirm')} onClick={dismissNotice} />}
        >
          {error ? <p>{translate(locale, lobbyErrorKey(error))}</p> : null}
        </LobbyNoticeLayer>
      ) : null}
    </div>
  );
}
