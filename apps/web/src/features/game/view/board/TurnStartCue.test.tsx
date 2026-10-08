// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { TurnStartCue } from '@/features/game/view/board/TurnStartCue';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* eslint-disable testing-library/no-node-access -- The aria-hidden visual wrapper owns the one-time CSS epoch. */
test('uses a localized accessible announcement without restarting on a label update', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(100);
  const cue = { identity: 'turn-1', timing: { startedAt: 0 } };
  const { rerender } = render(<TurnStartCue cue={cue} label='내 턴' />);
  const visual = screen.getByText('YOUR TURN').closest('[data-turn-cue]');
  expect(visual?.getAttribute('aria-hidden')).toBe('true');
  expect(visual?.getAttribute('style')).toContain('-100ms');
  expect(screen.getByRole('status').textContent).toBe('내 턴');
  now.mockReturnValue(500);
  rerender(<TurnStartCue cue={cue} label='Your turn' />);
  expect(screen.getByText('YOUR TURN').closest('[data-turn-cue]')).toBe(visual);
  expect(visual?.getAttribute('style')).toContain('-100ms');
  expect(screen.getByRole('status').textContent).toBe('Your turn');
});

/* eslint-enable testing-library/no-node-access */

test('skips a cue mounted after its display window', () => {
  vi.spyOn(performance, 'now').mockReturnValue(650);
  render(
    <TurnStartCue cue={{ identity: 'old-turn', timing: { startedAt: 0 } }} label='Your turn' />,
  );
  expect(screen.queryByText('YOUR TURN')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
});
