// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { PlayerSummary } from '@/features/game/view/board/PlayerSummary';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('preserves open bonus content and action identity while summary values hand off', () => {
  vi.spyOn(performance, 'now').mockReturnValue(850);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      public observe() {}
      public disconnect() {}
    },
  );
  const onOpenBonus = vi.fn();
  const onOpenScoreboard = vi.fn();
  const props = {
    player: { imageAlt: 'You', label: 'You' },
    labels: {
      total: 'Total 300',
      bonus: 'Bonus',
      bonusStatus: 'Earned',
      bonusInfo: 'Bonus info',
      scoreboard: 'Scoreboard',
    },
    displayOwner: 'viewer' as const,
    bonusEarned: true,
    bonusPopover: <div role='dialog'>Bonus rule</div>,
    onOpenBonus,
    onOpenScoreboard,
  };
  const feedback = {
    identity: 'record-1',
    categoryId: 'sixes' as const,
    score: 18,
    startedAt: 0,
    bonusEarned: true,
  };
  const { rerender } = render(
    <PlayerSummary {...props} recordFeedback={{ ...feedback, phase: 'outgoing' }} />,
  );
  const bonusAction = screen.getByRole('button', { name: 'Bonus info' });
  const scoreboardAction = screen.getByRole('button', { name: 'Scoreboard' });
  const dialog = screen.getByRole('dialog');
  rerender(
    <PlayerSummary
      {...props}
      displayOwner='opponent'
      player={{ imageAlt: 'Opponent', label: 'Opponent' }}
      recordFeedback={{ ...feedback, phase: 'incoming' }}
    />,
  );
  expect(screen.getByRole('button', { name: 'Bonus info' })).toBe(bonusAction);
  expect(screen.getByRole('button', { name: 'Scoreboard' })).toBe(scoreboardAction);
  expect(screen.getByRole('dialog')).toBe(dialog);
  fireEvent.click(bonusAction);
  fireEvent.click(scoreboardAction);
  expect(onOpenBonus).toHaveBeenCalledOnce();
  expect(onOpenScoreboard).toHaveBeenCalledOnce();
});

test('shows the first-bonus gain only for the admitted record confirmation', () => {
  vi.spyOn(performance, 'now').mockReturnValue(200);
  const props = {
    player: { imageAlt: 'You', label: 'You' },
    labels: {
      total: 'Total 300',
      bonus: 'Bonus',
      bonusStatus: 'Earned',
      bonusInfo: 'Bonus info',
      scoreboard: 'Scoreboard',
    },
    displayOwner: 'viewer' as const,
    bonusEarned: true,
  };
  const feedback = {
    identity: 'record-1',
    categoryId: 'sixes' as const,
    score: 18,
    startedAt: 0,
    phase: 'confirming' as const,
  };
  const { rerender } = render(
    <PlayerSummary {...props} recordFeedback={{ ...feedback, bonusEarned: false }} />,
  );
  expect(screen.queryByText('+35')).toBeNull();
  rerender(<PlayerSummary {...props} recordFeedback={{ ...feedback, bonusEarned: true }} />);
  expect(screen.getByText('+35')).toBeTruthy();
  rerender(
    <PlayerSummary
      {...props}
      recordFeedback={{ ...feedback, bonusEarned: true, phase: 'incoming' }}
    />,
  );
  expect(screen.queryByText('+35')).toBeNull();
});
