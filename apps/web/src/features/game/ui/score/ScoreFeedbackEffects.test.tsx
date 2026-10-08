// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */
/* eslint-disable testing-library/no-node-access, testing-library/no-container -- These aria-hidden decorative leaves expose timing through their DOM style and presence. */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import {
  BonusRecordEffect,
  RecordTransition,
  ScoreRecordEffect,
  YachtRing,
} from '@/features/game/ui/score/ScoreFeedbackEffects';
import type { ScoreRecordFeedback } from '@/features/game/ui/score/types';

const feedback: ScoreRecordFeedback = {
  identity: 'record-1',
  categoryId: 'twos',
  score: 6,
  phase: 'confirming',
  timing: { startedAt: 0 },
  bonusEarned: false,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test.each([
  { name: 'score', Effect: ScoreRecordEffect, selector: '.score-feedback__effect', expiry: 670 },
  {
    name: 'bonus',
    Effect: BonusRecordEffect,
    selector: '.player-summary__bonus-effect',
    expiry: 800,
  },
])(
  '$name effect keeps its running mount age and skips an expired remount',
  ({ Effect, selector, expiry }) => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    const running: ScoreRecordFeedback = { ...feedback, timing: { startedAt: 0 } };
    const { container, rerender, unmount } = render(<Effect feedback={running} />);
    const effect = container.querySelector<HTMLElement>(selector);
    expect(effect?.style.getPropertyValue('--record-delay')).toBe('-100ms');
    now.mockReturnValue(500);
    rerender(<Effect feedback={{ ...running }} />);
    expect(container.querySelector(selector)).toBe(effect);
    expect(effect?.style.getPropertyValue('--record-delay')).toBe('-100ms');
    unmount();
    now.mockReturnValue(expiry);
    const view = render(<Effect feedback={running} />);
    expect(view.container.querySelector(selector)).toBeNull();
  },
);

test('record transition preserves its running phase age on rerender and samples a late remount', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(850);
  const outgoing: ScoreRecordFeedback = {
    ...feedback,
    phase: 'outgoing',
    timing: { startedAt: 0 },
  };
  const { rerender, unmount } = render(
    <RecordTransition feedback={outgoing} style={{ color: 'red' }}>
      6
    </RecordTransition>,
  );
  const value = screen.getByText('6');
  expect(value.style.animationDelay).toBe('-50ms');
  now.mockReturnValue(875);
  rerender(
    <RecordTransition feedback={{ ...outgoing }} style={{ color: 'red' }}>
      6
    </RecordTransition>,
  );
  expect(screen.getByText('6')).toBe(value);
  expect(value.style.color).toBe('red');
  expect(value.style.animationDelay).toBe('-50ms');
  unmount();
  render(<RecordTransition feedback={outgoing}>6</RecordTransition>);
  expect(screen.getByText('6').style.animationDelay).toBe('-75ms');
});

test('recorded Yacht ring keeps its running mount age and skips an expired remount', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(100);
  const timing = { startedAt: 0 };
  const { container, rerender, unmount } = render(<YachtRing timing={timing} />);
  const ring = container.querySelector<SVGSVGElement>('svg');
  expect(ring?.style.animationDelay).toBe('-100ms');
  now.mockReturnValue(500);
  rerender(<YachtRing timing={{ ...timing }} />);
  expect(container.querySelector('svg')).toBe(ring);
  expect(ring?.style.animationDelay).toBe('-100ms');
  rerender(<YachtRing />);
  expect(container.querySelector('[data-yacht-ring="available"]')).toBe(ring);
  expect(ring?.style.animationDelay).toBe('0ms');
  unmount();
  now.mockReturnValue(650);
  expect(render(<YachtRing timing={timing} />).container.querySelector('svg')).toBeNull();
});

test('Yacht zero uses ordinary particles while Yacht fifty uses the recorded ring', () => {
  vi.spyOn(performance, 'now').mockReturnValue(350);
  const yacht: ScoreRecordFeedback = { ...feedback, categoryId: 'yacht', score: 0 };
  const { container, rerender } = render(<ScoreRecordEffect feedback={yacht} />);
  expect(container.querySelector('.score-feedback__particle')).not.toBeNull();
  expect(container.querySelector('[data-yacht-ring="recorded"]')).toBeNull();
  rerender(<ScoreRecordEffect feedback={{ ...yacht, score: 50 }} />);
  expect(container.querySelector('.score-feedback__particle')).toBeNull();
  expect(container.querySelector('[data-yacht-ring="recorded"]')).not.toBeNull();
});
