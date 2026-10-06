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
} from '@/features/game/view/score/RecordFeedback';
import type { ScoreRecordFeedback } from '@/features/game/view/score/types';

const feedback: ScoreRecordFeedback = {
  identity: 'record-1',
  categoryId: 'twos',
  score: 6,
  phase: 'confirming',
  timing: { mode: 'paused', elapsedMs: 350 },
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
  '$name effect seeks the same paused record, expires, and returns on backward seek',
  ({ Effect, selector, expiry }) => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(100);
    const { container, rerender } = render(<Effect feedback={feedback} />);
    const effect = container.querySelector<HTMLElement>(selector);
    expect(effect?.style.getPropertyValue('--record-delay')).toBe('-350ms');
    now.mockReturnValue(2_000);
    rerender(<Effect feedback={{ ...feedback }} />);
    expect(container.querySelector(selector)).toBe(effect);
    expect(effect?.style.getPropertyValue('--record-delay')).toBe('-350ms');

    rerender(<Effect feedback={{ ...feedback, timing: { mode: 'paused', elapsedMs: 500 } }} />);
    expect(container.querySelector(selector)).toBe(effect);
    expect(effect?.style.getPropertyValue('--record-delay')).toBe('-500ms');
    rerender(<Effect feedback={{ ...feedback, timing: { mode: 'paused', elapsedMs: expiry } }} />);
    expect(container.querySelector(selector)).toBeNull();
    rerender(<Effect feedback={{ ...feedback, timing: { mode: 'paused', elapsedMs: 100 } }} />);
    expect(container.querySelectorAll(selector)).toHaveLength(1);
    expect(
      container.querySelector<HTMLElement>(selector)?.style.getPropertyValue('--record-delay'),
    ).toBe('-100ms');
  },
);

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
    const running: ScoreRecordFeedback = { ...feedback, timing: { mode: 'running', startedAt: 0 } };
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

test('record transition seeks within a phase while preserving its content and supplied style', () => {
  const outgoing: ScoreRecordFeedback = {
    ...feedback,
    phase: 'outgoing',
    timing: { mode: 'paused', elapsedMs: 850 },
  };
  const { rerender } = render(
    <RecordTransition feedback={outgoing} style={{ color: 'red' }}>
      6
    </RecordTransition>,
  );
  const value = screen.getByText('6');
  expect(value.style.animationDelay).toBe('-50ms');
  rerender(
    <RecordTransition
      feedback={{ ...outgoing, timing: { mode: 'paused', elapsedMs: 875 } }}
      style={{ color: 'red' }}
    >
      6
    </RecordTransition>,
  );
  expect(screen.getByText('6')).toBe(value);
  expect(value.style.animationDelay).toBe('-75ms');
  expect(value.style.color).toBe('red');
  rerender(
    <RecordTransition feedback={{ ...outgoing, timing: { mode: 'paused', elapsedMs: 825 } }}>
      6
    </RecordTransition>,
  );
  expect(value.style.animationDelay).toBe('-25ms');
});

test('record transition preserves its running phase age on rerender and samples a late remount', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(850);
  const outgoing: ScoreRecordFeedback = {
    ...feedback,
    phase: 'outgoing',
    timing: { mode: 'running', startedAt: 0 },
  };
  const { rerender, unmount } = render(<RecordTransition feedback={outgoing}>6</RecordTransition>);
  const value = screen.getByText('6');
  expect(value.style.animationDelay).toBe('-50ms');
  now.mockReturnValue(875);
  rerender(<RecordTransition feedback={{ ...outgoing }}>6</RecordTransition>);
  expect(screen.getByText('6')).toBe(value);
  expect(value.style.animationDelay).toBe('-50ms');
  unmount();
  render(<RecordTransition feedback={outgoing}>6</RecordTransition>);
  expect(screen.getByText('6').style.animationDelay).toBe('-75ms');
});

test('recorded Yacht ring seeks, expires, and returns without restarting the available loop', () => {
  const { container, rerender } = render(<YachtRing timing={{ mode: 'paused', elapsedMs: 350 }} />);
  const ring = container.querySelector<SVGSVGElement>('[data-yacht-ring="recorded"]');
  expect(ring?.style.animationDelay).toBe('-350ms');
  rerender(<YachtRing timing={{ mode: 'paused', elapsedMs: 500 }} />);
  expect(container.querySelector('[data-yacht-ring="recorded"]')).toBe(ring);
  expect(ring?.style.animationDelay).toBe('-500ms');
  rerender(<YachtRing timing={{ mode: 'paused', elapsedMs: 650 }} />);
  expect(container.querySelector('svg')).toBeNull();
  rerender(<YachtRing timing={{ mode: 'paused', elapsedMs: 100 }} />);
  expect(container.querySelectorAll('[data-yacht-ring="recorded"]')).toHaveLength(1);
  expect(container.querySelector<SVGSVGElement>('svg')?.style.animationDelay).toBe('-100ms');
  rerender(<YachtRing />);
  expect(container.querySelector('[data-yacht-ring="available"]')).not.toBeNull();
  expect(container.querySelector<SVGSVGElement>('svg')?.style.animationDelay).toBe('0ms');
});

test('recorded Yacht ring keeps its running mount age and skips an expired remount', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(100);
  const timing = { mode: 'running' as const, startedAt: 0 };
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
  const yacht: ScoreRecordFeedback = { ...feedback, categoryId: 'yacht', score: 0 };
  const { container, rerender } = render(<ScoreRecordEffect feedback={yacht} />);
  expect(container.querySelector('.score-feedback__particle')).not.toBeNull();
  expect(container.querySelector('[data-yacht-ring="recorded"]')).toBeNull();
  rerender(<ScoreRecordEffect feedback={{ ...yacht, score: 50 }} />);
  expect(container.querySelector('.score-feedback__particle')).toBeNull();
  expect(container.querySelector('[data-yacht-ring="recorded"]')).not.toBeNull();
});
