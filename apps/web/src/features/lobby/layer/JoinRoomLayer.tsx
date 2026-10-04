import { LobbyLayer, PendingIndicator } from '@/features/lobby/layer/LobbyLayer';
import { LOBBY_ICONS } from '@/features/lobby/lobby-assets';
import { type LobbyError, lobbyErrorKey } from '@/features/lobby/lobby-errors';
import { RoomCodeInput } from '@/features/lobby/RoomCodeInput';
import { type Locale, translate } from '@/i18n';
import { Button, IconButton } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

export function JoinRoomLayer({
  locale,
  code,
  joining,
  rateLimited,
  showDelayedProgress,
  preparingServer,
  error,
  onClose,
  onJoin,
  onCodeChange,
  onCodeFocus,
}: Readonly<{
  locale: Locale;
  code: string;
  joining: boolean;
  rateLimited: boolean;
  showDelayedProgress: boolean;
  preparingServer: boolean;
  error: LobbyError | null;
  onClose: () => void;
  onJoin: () => void;
  onCodeChange: (code: string) => void;
  onCodeFocus: () => void;
}>) {
  return (
    <LobbyLayer admission='join'>
      <ScrollablePanel
        className='web-lobby-surface'
        title={translate(locale, 'lobby.joinRoom')}
        headerAction={
          <IconButton
            label={translate(locale, 'common.close')}
            icon={<img src={LOBBY_ICONS.close} alt='' />}
            interactionLocked={joining}
            onClick={onClose}
          />
        }
        footer={
          <Button
            label={translate(locale, 'lobby.joinSubmit')}
            interactionLocked={joining || rateLimited}
            progress={
              joining && showDelayedProgress ? (
                <PendingIndicator
                  label={translate(
                    locale,
                    preparingServer ? 'lobby.serverPreparing' : 'lobby.joinPending',
                  )}
                />
              ) : undefined
            }
            onClick={onJoin}
          />
        }
      >
        <div className='web-lobby-join'>
          <RoomCodeInput
            code={code}
            label={translate(locale, 'lobby.joinCodeLabel')}
            error={error}
            joining={joining}
            onCodeChange={onCodeChange}
            onCodeFocus={onCodeFocus}
          />
          <p
            id='lobby-code-error'
            className='product-inline-feedback web-lobby-error'
            role={error ? 'alert' : undefined}
          >
            {error
              ? translate(
                  locale,
                  error.kind === 'rate-limited' ? 'lobby.joinRateLimited' : lobbyErrorKey(error),
                )
              : null}
          </p>
        </div>
      </ScrollablePanel>
    </LobbyLayer>
  );
}
