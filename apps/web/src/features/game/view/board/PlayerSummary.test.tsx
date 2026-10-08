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
    timing: { startedAt: 0 },
    bonusEarned: true,
  };
  const { rerender } = render(
    <PlayerSummary {...props} recordFeedback={{ ...feedback, phase: 'outgoing' }} />,
  );
  const bonusAction = screen.getByRole('button', { name: 'Bonus info' });
  const scoreboardAction = screen.getByRole('button', { name: 'Scoreboard' });
  const dialog = screen.getByRole('dialog');
  bonusAction.focus();
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
  // eslint-disable-next-line testing-library/no-node-access -- Focus must stay on the persistent bonus action.
  expect(document.activeElement).toBe(bonusAction);
  fireEvent.click(bonusAction);
  fireEvent.click(scoreboardAction);
  expect(onOpenBonus).toHaveBeenCalledOnce();
  expect(onOpenScoreboard).toHaveBeenCalledOnce();
});

/* eslint-disable testing-library/no-node-access -- Popover geometry and label replacement are local DOM contracts. */
test('keeps the open bonus popover anchored to the replacement label when only record identity changes', () => {
  vi.spyOn(performance, 'now').mockReturnValue(850);
  const observers: { notify: () => void; disconnect: ReturnType<typeof vi.fn> }[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      public disconnect: ReturnType<typeof vi.fn> = vi.fn();
      public constructor(callback: () => void) {
        observers.push({ notify: callback, disconnect: this.disconnect });
      }
      public observe() {}
    },
  );
  const bounds = (left: number, top: number, width: number, height: number) =>
    new DOMRect(left, top, width, height);
  let initialLabel: HTMLElement | undefined;
  let replacementBounds = bounds(410, 40, 60, 25);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains('player-summary')) return bounds(100, 20, 360, 50);
    if (this.classList.contains('player-summary__bonus-anchor')) return bounds(300, 20, 80, 50);
    if (this.classList.contains('player-summary__bonus')) {
      initialLabel ??= this;
      if (!this.isConnected) return bounds(0, 0, 0, 0);
      return this === initialLabel ? bounds(300, 30, 40, 20) : replacementBounds;
    }
    return bounds(0, 0, 0, 0);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('player-summary') ? 360 : 160;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
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
  };
  const feedback = {
    identity: 'record-1',
    categoryId: 'sixes' as const,
    score: 18,
    timing: { startedAt: 0 },
    phase: 'outgoing' as const,
    bonusEarned: true,
  };
  const { rerender, unmount } = render(<PlayerSummary {...props} recordFeedback={feedback} />);
  const bonusAction = screen.getByRole('button', { name: 'Bonus info' });
  const scoreboardAction = screen.getByRole('button', { name: 'Scoreboard' });
  const dialog = screen.getByRole('dialog');
  const popover = dialog.parentElement!;
  const label = screen.getByText('Bonus');
  bonusAction.focus();
  expect(popover.style.left).toBe('-60px');
  expect(popover.style.top).toBe('38px');
  expect(popover.style.getPropertyValue('--bonus-pointer-left')).toBe('80px');

  rerender(<PlayerSummary {...props} recordFeedback={{ ...feedback, identity: 'record-2' }} />);
  expect(screen.getByText('Bonus')).not.toBe(label);
  expect(label.isConnected).toBe(false);
  expect(screen.getByRole('button', { name: 'Bonus info' })).toBe(bonusAction);
  expect(screen.getByRole('button', { name: 'Scoreboard' })).toBe(scoreboardAction);
  expect(screen.getByRole('dialog')).toBe(dialog);
  expect(document.activeElement).toBe(bonusAction);
  expect(popover.style.left).toBe('0px');
  expect(popover.style.top).toBe('53px');
  expect(popover.style.getPropertyValue('--bonus-pointer-left')).toBe('140px');
  expect(observers[0]?.disconnect).toHaveBeenCalledOnce();

  replacementBounds = bounds(330, 45, 40, 25);
  observers[1]?.notify();
  expect(popover.style.left).toBe('-30px');
  expect(popover.style.top).toBe('58px');
  expect(popover.style.getPropertyValue('--bonus-pointer-left')).toBe('80px');
  unmount();
  expect(observers[1]?.disconnect).toHaveBeenCalledOnce();
});
/* eslint-enable testing-library/no-node-access */

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
    timing: { startedAt: 0 },
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
