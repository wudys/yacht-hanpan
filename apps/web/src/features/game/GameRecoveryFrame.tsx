import { CLIENT_ERROR_CODE, type ClientError } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import type { ReactNode } from 'react';

import type { GameRecoveryPresentation } from '@/features/game/interaction/game-interaction';
import { CLIENT_ERROR_MESSAGE_KEY, type Locale, PUBLIC_ERROR_MESSAGE_KEY, translate } from '@/i18n';
import { Button } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';
import { ColorCycleDiceLoader } from '@/ui/status';

export function GameRecoveryFrame({
  children,
  locale,
  presentation,
  onDismissRateLimit,
  onPermanentFailure,
  onRefresh,
  onRetryCommand,
}: Readonly<{
  children: ReactNode;
  locale: Locale;
  presentation: GameRecoveryPresentation;
  onDismissRateLimit: () => void;
  onPermanentFailure: () => void;
  onRefresh: () => void;
  onRetryCommand: () => void;
}>) {
  const { surface, recoveryBlocked } = presentation;
  const progress = surface.kind === 'progress' ? surface : null;
  const terminal = surface.kind === 'terminal' ? surface : null;
  const terminalCode =
    terminal?.error?.kind === 'server' ? terminal.error.error.code : terminal?.error?.code;
  const recoveryStopped =
    terminal?.status === 'refreshRequired' && terminalCode !== CLIENT_ERROR_CODE.PROTOCOL_MISMATCH;
  const notice = terminal
    ? {
        kind: 'terminal' as const,
        status: terminal.status,
        message:
          recoveryStopped || terminal.error === null
            ? translate(locale, 'lobby.reentryRefresh')
            : recoveryErrorMessage(locale, terminal.error),
        label: translate(
          locale,
          terminal.status === 'permanentFailure' ? 'common.confirm' : 'common.refresh',
        ),
        onIntent: terminal.status === 'permanentFailure' ? onPermanentFailure : onRefresh,
      }
    : surface.kind === 'rate-limited'
      ? {
          kind: 'rate-limited' as const,
          message: translate(locale, 'error.rateLimited'),
          label: translate(locale, 'common.confirm'),
          onIntent: onDismissRateLimit,
        }
      : surface.kind === 'retryable'
        ? {
            kind: 'retryable' as const,
            message: recoveryErrorMessage(locale, surface.error),
            label: translate(locale, 'common.retry'),
            onIntent: onRetryCommand,
          }
        : null;

  return (
    <div
      className='web-game-recovery-host'
      data-game-recovery={terminal?.status ?? progress?.status ?? 'idle'}
    >
      <div
        className='web-game-interaction-surface'
        data-game-interaction-surface='true'
        role='group'
        aria-label={translate(locale, 'game.title')}
        inert={recoveryBlocked || undefined}
        aria-hidden={recoveryBlocked || undefined}
      >
        {children}
      </div>
      {progress ? (
        <div
          className='web-game-recovery-overlay'
          data-game-recovery-overlay={progress.status}
          role='status'
          aria-live='polite'
        >
          <ColorCycleDiceLoader />
          <p>
            {translate(
              locale,
              progress.status === 'reconnecting'
                ? 'lobby.reentryConnecting'
                : 'lobby.reentrySynchronizing',
            )}
          </p>
        </div>
      ) : null}
      {notice ? (
        <div
          className='web-game-recovery-terminal'
          data-game-recovery-terminal={notice.kind === 'terminal' ? notice.status : undefined}
          data-game-command-notice={notice.kind === 'terminal' ? undefined : notice.kind}
          role='alertdialog'
          aria-modal='true'
          aria-label={translate(locale, 'common.noticeTitle')}
        >
          <ScrollablePanel
            variant='notice'
            title={translate(locale, 'common.noticeTitle')}
            footer={<Button label={notice.label} onClick={notice.onIntent} />}
          >
            <p>{notice.message}</p>
          </ScrollablePanel>
        </div>
      ) : null}
    </div>
  );
}

function recoveryErrorMessage(locale: Locale, error: ClientError): string {
  if (error.kind === 'server') {
    if (error.error.code === PUBLIC_ERROR_CODE.ROOM_NOT_FOUND)
      return translate(locale, 'error.gameNotFound');
    return translate(locale, PUBLIC_ERROR_MESSAGE_KEY[error.error.code]);
  }
  return translate(locale, CLIENT_ERROR_MESSAGE_KEY[error.code]);
}
