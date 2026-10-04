// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- stop notice timers before restoring the clock. */

import { parsePresenceSnapshot } from '@repo/game-protocol/socket';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { GamePresenceNotice, GamePresenceProvider } from '@/features/game/GamePresenceNotice';
import { LOCALE, translate } from '@/i18n';
import { room } from '@/testing/game-fixtures';

const disconnectedPresence = parsePresenceSnapshot({
  roomId: room.roomId,
  presenceVersion: 1,
  seats: [{ status: 'disconnected', reconnectDeadlineAt: 80_000 }],
}).seats[0];
if (disconnectedPresence.status !== 'disconnected')
  throw new Error('Expected a disconnected presence fixture');
const { reconnectDeadlineAt } = disconnectedPresence;

function PresenceHarness(props: Omit<ComponentProps<typeof GamePresenceProvider>, 'children'>) {
  return (
    <GamePresenceProvider {...props}>
      <GamePresenceNotice />
    </GamePresenceProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test.each([LOCALE.KO, LOCALE.EN])(
  'prioritizes disconnect over storage warnings and expires reconnection in %s',
  (locale) => {
    vi.useFakeTimers();
    const props = {
      identity: {},
      reconnectDeadlineAt,
      persistence: 'memoryOnly' as const,
      locale,
    };
    const { rerender } = render(<PresenceHarness {...props} status='connected' />);
    expect(screen.getByRole('status').textContent).toBe(
      translate(locale, 'session.storageFailure'),
    );
    rerender(<PresenceHarness {...props} status='disconnected' />);
    expect(screen.getByRole('status').textContent).toBe(
      translate(locale, 'game.opponentDisconnected'),
    );
    rerender(<PresenceHarness {...props} status='connected' persistence='saved' />);
    expect(screen.getByRole('status').textContent).toBe(
      translate(locale, 'game.opponentReconnected'),
    );
    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(screen.getByRole('status').textContent).toBe(
      translate(locale, 'game.opponentReconnected'),
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByRole('status')).toBeNull();
  },
);

test('ignores initial connection waiting and clears the previous session notice and timer', () => {
  vi.useFakeTimers();
  const props = {
    identity: {},
    reconnectDeadlineAt: null,
    persistence: 'saved' as const,
    locale: LOCALE.EN,
  };
  const { rerender, unmount } = render(<PresenceHarness {...props} status='disconnected' />);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(<PresenceHarness {...props} status='connected' />);
  expect(screen.queryByRole('status')).toBeNull();
  rerender(
    <PresenceHarness {...props} status='disconnected' reconnectDeadlineAt={reconnectDeadlineAt} />,
  );
  expect(screen.getByRole('status').textContent).toBe(
    translate(LOCALE.EN, 'game.opponentDisconnected'),
  );
  rerender(<PresenceHarness {...props} status='connected' />);
  expect(vi.getTimerCount()).toBe(1);
  rerender(<PresenceHarness {...props} identity={{}} status='connected' />);
  expect(screen.queryByRole('status')).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  rerender(
    <PresenceHarness {...props} status='disconnected' reconnectDeadlineAt={reconnectDeadlineAt} />,
  );
  rerender(<PresenceHarness {...props} status='connected' />);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
