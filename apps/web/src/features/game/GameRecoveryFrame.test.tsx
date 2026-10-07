// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import type { ClientError } from '@repo/game-client-sdk/errors';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { deriveGameRecoveryPresentation } from '@/features/game/game-interaction';
import { GameRecoveryFrame } from '@/features/game/GameRecoveryFrame';
import { LOCALE, translate } from '@/i18n';

afterEach(cleanup);

const retryError: ClientError = { kind: 'transport', code: 'ACK_TIMEOUT' };
const roomError: ClientError = {
  kind: 'server',
  error: { code: 'ROOM_NOT_FOUND', params: {} },
};

for (const locale of [LOCALE.KO, LOCALE.EN]) {
  test.each([
    { snapshot: { status: 'reconnecting' }, message: 'lobby.reentryConnecting' },
    { snapshot: { status: 'synchronizing' }, message: 'lobby.reentrySynchronizing' },
  ] as const)(
    `${locale} $snapshot.status progress covers command notices and blocks its background`,
    ({ snapshot, message }) => {
      render(
        <GameRecoveryFrame
          locale={locale}
          presentation={deriveGameRecoveryPresentation({
            snapshot,
            rateLimited: true,
            commandRetryError: retryError,
          })}
          onDismissRateLimit={vi.fn()}
          onPermanentFailure={vi.fn()}
          onRefresh={vi.fn()}
          onRetryCommand={vi.fn()}
        >
          <button>Background action</button>
        </GameRecoveryFrame>,
      );
      const background = screen.getByRole('group', { hidden: true });
      expect(background.hasAttribute('inert')).toBe(true);
      expect(background.getAttribute('aria-hidden')).toBe('true');
      expect(screen.queryByRole('button')).toBeNull();
      expect(
        within(screen.getByRole('status')).getByText(translate(locale, message)),
      ).not.toBeNull();
      expect(screen.queryByRole('alertdialog')).toBeNull();
    },
  );

  test.each([
    {
      snapshot: { status: 'permanentFailure', error: roomError },
      rateLimited: true,
      commandRetryError: retryError,
      message: 'error.gameNotFound',
      label: 'common.confirm',
      intent: 'onPermanentFailure',
    },
    {
      snapshot: { status: 'refreshRequired', error: null },
      rateLimited: true,
      commandRetryError: retryError,
      message: 'lobby.reentryRefresh',
      label: 'common.refresh',
      intent: 'onRefresh',
    },
    {
      snapshot: { status: 'refreshRequired', error: retryError },
      rateLimited: false,
      commandRetryError: null,
      message: 'lobby.reentryRefresh',
      label: 'common.refresh',
      intent: 'onRefresh',
    },
    {
      snapshot: {
        status: 'refreshRequired',
        error: { kind: 'protocol', code: 'PROTOCOL_MISMATCH' },
      },
      rateLimited: false,
      commandRetryError: null,
      message: 'error.protocolMismatch',
      label: 'common.refresh',
      intent: 'onRefresh',
    },
    {
      snapshot: { status: 'idle' },
      rateLimited: true,
      commandRetryError: retryError,
      message: 'error.rateLimited',
      label: 'common.confirm',
      intent: 'onDismissRateLimit',
    },
    {
      snapshot: { status: 'idle' },
      rateLimited: false,
      commandRetryError: roomError,
      message: 'error.gameNotFound',
      label: 'common.retry',
      intent: 'onRetryCommand',
    },
  ] as const)(
    `${locale} $snapshot.status $message keeps its message and action accessible`,
    ({ snapshot, rateLimited, commandRetryError, message, label, intent }) => {
      const callbacks = {
        onDismissRateLimit: vi.fn(),
        onPermanentFailure: vi.fn(),
        onRefresh: vi.fn(),
        onRetryCommand: vi.fn(),
      };
      render(
        <GameRecoveryFrame
          locale={locale}
          presentation={deriveGameRecoveryPresentation({
            snapshot,
            rateLimited,
            commandRetryError,
          })}
          {...callbacks}
        >
          <button>Background action</button>
        </GameRecoveryFrame>,
      );
      const background = screen.getByRole('group', { hidden: true });
      expect(background.hasAttribute('inert')).toBe(true);
      expect(background.getAttribute('aria-hidden')).toBe('true');
      const notice = screen.getByRole('alertdialog');
      expect(within(notice).getByText(translate(locale, message))).not.toBeNull();
      fireEvent.click(within(notice).getByRole('button', { name: translate(locale, label) }));
      for (const [name, callback] of Object.entries(callbacks)) {
        expect(callback).toHaveBeenCalledTimes(name === intent ? 1 : 0);
      }
    },
  );

  test(`${locale} idle without a notice exposes the background`, () => {
    const action = vi.fn();
    render(
      <GameRecoveryFrame
        locale={locale}
        presentation={deriveGameRecoveryPresentation({
          snapshot: { status: 'idle' },
          rateLimited: false,
          commandRetryError: null,
        })}
        onDismissRateLimit={vi.fn()}
        onPermanentFailure={vi.fn()}
        onRefresh={vi.fn()}
        onRetryCommand={vi.fn()}
      >
        <button onClick={action}>Background action</button>
      </GameRecoveryFrame>,
    );
    const background = screen.getByRole('group');
    expect(background.hasAttribute('inert')).toBe(false);
    expect(background.hasAttribute('aria-hidden')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Background action' }));
    expect(action).toHaveBeenCalledOnce();
  });
}
