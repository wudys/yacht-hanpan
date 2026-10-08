import { LobbyLayer } from '@/features/lobby/layer/LobbyLayer';
import { LOBBY_ICONS } from '@/features/lobby/lobby-assets';
import { type Locale, translate } from '@/i18n';
import type { WaitingRoomSummary } from '@/runtime/room-access/room-access';
import { IconButton } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';
import { BouncingDiceLoader } from '@/ui/status';

export type CopyStatus = 'idle' | 'copied' | 'failed';

export function WaitingRoomLayer({
  locale,
  waitingRoom,
  matching,
  recovery,
  remainingSeconds,
  copyStatus,
  onCancel,
  onCopy,
}: Readonly<{
  locale: Locale;
  waitingRoom: WaitingRoomSummary | null;
  matching: boolean;
  recovery: 'none' | 'reconnecting' | 'synchronizing';
  remainingSeconds: number;
  copyStatus: CopyStatus;
  onCancel: () => void;
  onCopy: () => void;
}>) {
  const waitingRecovery = recovery !== 'none';
  return (
    <LobbyLayer kind='waiting'>
      <ScrollablePanel
        className='web-lobby-surface'
        title={translate(locale, 'lobby.createRoom')}
        headerAction={
          <IconButton
            label={translate(locale, 'lobby.cancelWait')}
            icon={<img src={LOBBY_ICONS.close} alt='' />}
            interactionLocked={matching}
            onClick={onCancel}
          />
        }
      >
        <div className='web-lobby-waiting' role='status'>
          {waitingRoom ? (
            <>
              <div className='web-lobby-room-code-meta'>
                <span className='web-lobby-room-code-label'>
                  {translate(locale, 'lobby.roomCode')}
                </span>
                {!matching ? (
                  <time
                    className='web-lobby-countdown'
                    aria-label={`${remainingSeconds}${translate(locale, 'game.seconds')}`}
                  >
                    <svg viewBox='0 0 24 24' aria-hidden='true'>
                      <circle cx='12' cy='12' r='9' />
                      <path d='M12 6v6h5' />
                    </svg>
                    {String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:
                    {String(remainingSeconds % 60).padStart(2, '0')}
                  </time>
                ) : null}
              </div>
              <div className='web-lobby-room-code'>
                <strong data-room-code={waitingRoom.roomCode}>{waitingRoom.roomCode}</strong>
                <button
                  type='button'
                  className='web-lobby-copy-button'
                  aria-label={translate(
                    locale,
                    copyStatus === 'copied'
                      ? 'lobby.copied'
                      : copyStatus === 'failed'
                        ? 'lobby.copyFailed'
                        : 'lobby.copy',
                  )}
                  disabled={matching || waitingRecovery}
                  data-copy-status={copyStatus}
                  onClick={onCopy}
                >
                  <CopyStatusIcon status={copyStatus} />
                </button>
              </div>
            </>
          ) : null}
          {waitingRoom ? (
            <small
              className='product-inline-feedback web-lobby-copy-feedback'
              role={copyStatus === 'failed' ? 'alert' : undefined}
              aria-hidden={copyStatus === 'failed' ? undefined : true}
              data-visible={copyStatus === 'failed'}
            >
              {translate(locale, 'lobby.copyFailed')}
            </small>
          ) : null}
          <div className='web-lobby-waiting__status'>
            <BouncingDiceLoader />
            <p className='web-lobby-waiting__headline'>
              {translate(
                locale,
                waitingRecovery
                  ? recovery === 'synchronizing'
                    ? 'lobby.reentrySynchronizing'
                    : 'lobby.reconnecting'
                  : matching
                    ? 'lobby.gamePreparing'
                    : 'lobby.waitingForOpponent',
              )}
            </p>
            {!waitingRecovery ? (
              <p className='web-lobby-waiting__support'>{translate(locale, 'lobby.shareCode')}</p>
            ) : null}
          </div>
        </div>
      </ScrollablePanel>
    </LobbyLayer>
  );
}

function CopyStatusIcon({ status }: Readonly<{ status: CopyStatus }>) {
  if (status === 'copied') {
    return (
      <svg viewBox='0 0 24 24' aria-hidden='true'>
        <path d='m5 12 4 4L19 6' />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg viewBox='0 0 24 24' aria-hidden='true'>
        <path d='M6 6l12 12M18 6 6 18' />
      </svg>
    );
  }
  return (
    <svg viewBox='0 0 24 24' aria-hidden='true'>
      <rect x='8' y='8' width='11' height='11' rx='2' />
      <path d='M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2' />
    </svg>
  );
}
