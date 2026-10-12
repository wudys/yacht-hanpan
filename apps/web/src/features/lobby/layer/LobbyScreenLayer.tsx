import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import type { ComponentProps } from 'react';

import { JoinRoomLayer } from '@/features/lobby/layer/JoinRoomLayer';
import { LobbyLayer, LobbyNoticeLayer } from '@/features/lobby/layer/LobbyLayer';
import { ProfileLayer } from '@/features/lobby/layer/ProfileLayer';
import { WaitingRoomLayer } from '@/features/lobby/layer/WaitingRoomLayer';
import { lobbyError, lobbyErrorKey } from '@/features/lobby/lobby-errors';
import type { LobbyFlow } from '@/features/lobby/use-lobby-flow';
import type { useRoomCodeClipboard } from '@/features/lobby/use-room-code-clipboard';
import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { type Locale, type MessageKeyWithoutParams, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { AUDIO_CUE } from '@/runtime/audio/cue-runtime';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';
import { Button } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';
import { ColorCycleDiceLoader } from '@/ui/status';

/** Selects the visible layer; accepted inputs and request lifetimes belong to the lobby flow. */
export function LobbyScreenLayer({
  flow,
  locale,
  audio,
  preferences,
  profile,
  clipboard,
}: Readonly<{
  flow: LobbyFlow;
  locale: Locale;
  audio: BrowserAudioRuntime;
  preferences: PreferencesStore;
  profile: Omit<ComponentProps<typeof ProfileLayer>, 'locale' | 'onClose'>;
  clipboard: ReturnType<typeof useRoomCodeClipboard>;
}>) {
  const { screenState, reentryState, error } = flow;
  if (reentryState.status !== 'idle' || screenState === 'checkingExpiry') {
    return (
      <ReentryLayer
        state={reentryState}
        checkingExpiry={screenState === 'checkingExpiry'}
        locale={locale}
        onConfirm={() => {
          audio.playCue(AUDIO_CUE.CLICK);
          flow.confirmAuthorityFailure();
        }}
      />
    );
  }

  const message = error === null ? null : lobbyErrorKey(error);
  switch (screenState) {
    case 'profile':
      return <ProfileLayer {...profile} locale={locale} onClose={flow.closeProfile} />;
    case 'settings':
      return (
        <LobbyLayer kind='settings'>
          <SettingsPanel audio={audio} preferences={preferences} onClose={flow.closeSettings} />
        </LobbyLayer>
      );
    case 'joinRoom':
    case 'joining':
      return (
        <JoinRoomLayer
          locale={locale}
          code={flow.joinCode}
          joining={screenState === 'joining'}
          rateLimited={flow.rateLimited}
          showDelayedProgress={flow.showDelayedProgress}
          preparingServer={flow.readinessOperation === 'join'}
          error={error}
          onClose={flow.closeJoinRoom}
          onJoin={flow.joinRoom}
          onCodeChange={flow.changeJoinCode}
          onCodeFocus={flow.focusJoinCode}
        />
      );
    case 'waiting':
    case 'matching':
      return (
        <WaitingRoomLayer
          locale={locale}
          waitingRoom={flow.waitingRoom}
          matching={screenState === 'matching'}
          recovery={screenState === 'waiting' ? waitingRecovery(flow.recoveryPhase) : 'none'}
          remainingSeconds={flow.remainingSeconds}
          copyStatus={clipboard.status}
          onCancel={flow.cancelWaiting}
          onCopy={() => void clipboard.copy()}
        />
      );
    case 'cancelFailed':
      return (
        <Notice
          key='cancelFailed'
          locale={locale}
          title='lobby.cancelFailedTitle'
          message='lobby.cancelFailed'
          action='common.retry'
          onAction={flow.cancelWaiting}
        />
      );
    case 'createFailed':
      return (
        <Notice
          key='createFailed'
          locale={locale}
          title='lobby.createFailedTitle'
          message={message}
          action='common.close'
          onAction={flow.dismissNotice}
        />
      );
    case 'connectionFailed':
      return (
        <Notice
          key='connectionFailed'
          locale={locale}
          title='lobby.connectionFailedTitle'
          message={message}
          action='common.refresh'
          onAction={() => window.location.reload()}
        />
      );
    case 'expired':
    case 'notice':
    case 'createNotice':
      return (
        <Notice
          key='notice'
          locale={locale}
          title='common.noticeTitle'
          message={message}
          action='common.confirm'
          onAction={flow.dismissNotice}
        />
      );
    default:
      return null;
  }
}

function waitingRecovery(phase: LobbyFlow['recoveryPhase']) {
  if (phase === 'reconnecting' || phase === 'synchronizing') return phase;
  return 'none';
}

function ReentryLayer({
  state,
  checkingExpiry,
  locale,
  onConfirm,
}: Readonly<{
  state: LobbyFlow['reentryState'];
  checkingExpiry: boolean;
  locale: Locale;
  onConfirm: () => void;
}>) {
  const progressing =
    state.status !== 'idle' &&
    state.status !== 'permanentFailure' &&
    state.status !== 'refreshRequired';
  function progressMessage(): MessageKeyWithoutParams {
    if (checkingExpiry || state.status === 'checking') return 'lobby.reentryChecking';
    if (state.status === 'synchronizing' || state.status === 'gameReady')
      return 'lobby.reentrySynchronizing';
    return 'lobby.reentryConnecting';
  }
  return (
    <>
      {progressing || checkingExpiry ? (
        <LobbyLayer kind='reentry'>
          <ScrollablePanel className='web-lobby-surface' title={translate(locale, 'lobby.resume')}>
            <div className='web-lobby-reentry' data-reentry-state={state.status} role='status'>
              <ColorCycleDiceLoader />
              <p>{translate(locale, progressMessage())}</p>
            </div>
          </ScrollablePanel>
        </LobbyLayer>
      ) : null}
      {state.status === 'permanentFailure' ? (
        <Notice
          locale={locale}
          title='lobby.reentryFailedTitle'
          message={
            state.error.kind === 'server' &&
            state.error.error.code === PUBLIC_ERROR_CODE.ROOM_NOT_FOUND
              ? 'error.gameNotFound'
              : lobbyErrorKey(lobbyError(state.error))
          }
          action='common.confirm'
          onAction={onConfirm}
        />
      ) : null}
      {state.status === 'refreshRequired' ? (
        <Notice
          locale={locale}
          title='lobby.reentryFailedTitle'
          message={
            state.reason === 'storage' ? 'session.storageUnavailable' : 'lobby.reentryRefresh'
          }
          action='common.refresh'
          onAction={() => window.location.reload()}
        />
      ) : null}
    </>
  );
}

function Notice({
  locale,
  title,
  message,
  action,
  onAction,
}: Readonly<{
  locale: Locale;
  title: MessageKeyWithoutParams;
  message: MessageKeyWithoutParams | null;
  action: MessageKeyWithoutParams;
  onAction: () => void;
}>) {
  return (
    <LobbyNoticeLayer
      title={translate(locale, title)}
      actions={<Button label={translate(locale, action)} onClick={onAction} />}
    >
      {message === null ? null : <p>{translate(locale, message)}</p>}
    </LobbyNoticeLayer>
  );
}
