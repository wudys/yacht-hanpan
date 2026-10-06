// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */
/* eslint-disable testing-library/no-node-access -- Observe fixture effects and preview values at their DOM boundary. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { VisualFixture } from '@/dev/VisualFixture';
import { LOCALE } from '@/i18n';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      public observe() {}
      public disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('shows the opponent preview and group maximum together without accepting input', () => {
  render(
    <VisualFixture
      anchor='game'
      mode='before-roll'
      locale={LOCALE.EN}
      feedback={{
        scenario: 'yacht-available',
        elapsed: 350,
        recorder: 'opponent',
        sameAvatar: false,
      }}
    />,
  );
  const cell = screen.getByRole('button', { name: 'Yacht · 50' });
  expect(cell.getAttribute('data-value-state')).toBe('preview');
  expect(cell.getAttribute('data-input-available')).toBe('false');
  expect(cell.hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('tab', { name: /Lower.*Max 50/u })).toBeTruthy();
  fireEvent.click(cell);
  expect(cell.closest('[data-last-intent]')?.getAttribute('data-last-intent')).toBe('none');
});

test.each(['replay', 'achievement'] as const)(
  'withholds the cell and group previews together before disclosure during %s',
  (phase) => {
    render(
      <VisualFixture
        anchor={phase === 'achievement' ? 'achievement' : 'game'}
        mode='yacht'
        locale={LOCALE.EN}
        replay={phase === 'replay' ? <div>Replay</div> : undefined}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Yacht · Unrecorded' }).getAttribute('data-value-state'),
    ).toBe('empty');
    expect(screen.getByRole('tab', { name: 'Upper' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Lower' })).toBeTruthy();
    expect(screen.queryByText(/Max/u)).toBeNull();
  },
);

test('retains recorded values while hiding previews throughout record confirmation', () => {
  render(
    <VisualFixture
      anchor='game'
      mode='before-roll'
      locale={LOCALE.EN}
      feedback={{ scenario: 'score', elapsed: 350, recorder: 'viewer', sameAvatar: false }}
    />,
  );
  expect(screen.getByRole('button', { name: 'Sixes · 18' }).getAttribute('data-value-state')).toBe(
    'recorded',
  );
  expect(
    screen.getByRole('button', { name: 'Twos · Unrecorded' }).getAttribute('data-value-state'),
  ).toBe('empty');
  expect(screen.getByRole('tab', { name: 'Upper' })).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Lower' })).toBeTruthy();
});

test('preserves settled preview data while pending blocks score input', () => {
  render(<VisualFixture anchor='game' mode='pending' locale={LOCALE.EN} />);
  const cell = screen.getByRole('button', { name: 'Choice · 19' });
  expect(cell.getAttribute('data-value-state')).toBe('preview');
  expect(cell.getAttribute('data-input-available')).toBe('false');
  expect(screen.getByRole('tab', { name: /Lower.*Max 19/u })).toBeTruthy();
  fireEvent.click(cell);
  expect(cell.closest('[data-last-intent]')?.getAttribute('data-last-intent')).toBe('none');
});

test.each(['score', 'bonus'] as const)(
  'keeps paused %s at the selected time after waiting, tab remount and locale changes',
  (scenario) => {
    vi.useFakeTimers({ toFake: ['performance'] });
    const feedback = { scenario, elapsed: 350, recorder: 'viewer' as const, sameAvatar: false };
    const { rerender } = render(
      <VisualFixture anchor='game' mode='before-roll' locale={LOCALE.EN} feedback={feedback} />,
    );
    const cell = screen.getByRole('button', { name: 'Sixes · 18' });
    expect(cell.querySelector('.score-feedback__effect')?.getAttribute('style')).toContain(
      '-350ms',
    );
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    fireEvent.click(screen.getByRole('tab', { name: 'Lower' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Upper' }));
    const remounted = screen.getByRole('button', { name: 'Sixes · 18' });
    const effect = remounted.querySelector('.score-feedback__effect');
    expect(effect).not.toBeNull();
    expect(effect?.getAttribute('style')).toContain('-350ms');
    const bonusEffect = scenario === 'bonus' ? screen.getByText('+35').parentElement : null;
    rerender(
      <VisualFixture anchor='game' mode='before-roll' locale={LOCALE.KO} feedback={feedback} />,
    );
    expect(remounted.querySelector('.score-feedback__effect')?.getAttribute('style')).toContain(
      '-350ms',
    );
    rerender(
      <VisualFixture
        anchor='game'
        mode='before-roll'
        locale={LOCALE.EN}
        feedback={{ ...feedback, elapsed: 500 }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Sixes · 18' })).toBe(remounted);
    expect(remounted.querySelector('.score-feedback__effect')).toBe(effect);
    expect(effect?.getAttribute('style')).toContain('-500ms');
    if (scenario === 'bonus') {
      expect(screen.getByText('+35').parentElement).toBe(bonusEffect);
      expect(bonusEffect?.getAttribute('style')).toContain('-500ms');
    }
  },
);

test.each([
  { scenario: 'score', elapsed: 670 },
  { scenario: 'yacht', elapsed: 670 },
  { scenario: 'bonus', elapsed: 800 },
] as const)('omits expired effects at paused $scenario age $elapsed', ({ scenario, elapsed }) => {
  render(
    <VisualFixture
      anchor='game'
      mode='before-roll'
      locale={LOCALE.EN}
      feedback={{ scenario, elapsed, recorder: 'viewer', sameAvatar: false }}
    />,
  );
  const board = screen.getByRole('main');
  expect(board.querySelector('.score-feedback__effect')).toBeNull();
  expect(board.querySelector('[data-yacht-ring="recorded"]')).toBeNull();
  expect(screen.queryByText('+35')).toBeNull();
});

test('seeking across the handoff updates the owner while retaining the cell and summary actions', () => {
  const feedback = {
    scenario: 'score' as const,
    elapsed: 850,
    recorder: 'viewer' as const,
    sameAvatar: false,
  };
  const { rerender } = render(
    <VisualFixture anchor='game' mode='before-roll' locale={LOCALE.EN} feedback={feedback} />,
  );
  const cell = screen.getByRole('button', { name: 'Sixes · 18' });
  const bonusAction = screen.getByRole('button', { name: /bonus/iu });
  const summary = bonusAction.closest('[data-player-summary]');
  expect(summary?.getAttribute('data-player-summary')).toBe('viewer');
  expect(summary?.querySelector('[data-score-transition="outgoing"]')).not.toBeNull();
  bonusAction.focus();

  rerender(
    <VisualFixture
      anchor='game'
      mode='before-roll'
      locale={LOCALE.EN}
      feedback={{ ...feedback, elapsed: 950 }}
    />,
  );
  expect(summary?.getAttribute('data-player-summary')).toBe('opponent');
  expect(summary?.querySelector('[data-score-transition="incoming"]')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Sixes · Unrecorded' })).toBe(cell);
  expect(screen.getByRole('button', { name: /bonus/iu })).toBe(bonusAction);
  expect(document.activeElement).toBe(bonusAction);
});

test('keeps a paused turn cue on locale changes and updates only its effect when seeking', () => {
  vi.useFakeTimers({ toFake: ['performance'] });
  const feedback = {
    scenario: 'turn' as const,
    elapsed: 350,
    recorder: 'viewer' as const,
    sameAvatar: false,
  };
  const { rerender } = render(
    <VisualFixture anchor='game' mode='before-roll' locale={LOCALE.EN} feedback={feedback} />,
  );
  const cue = screen.getByText('YOUR TURN').closest('[data-turn-cue]');
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  rerender(
    <VisualFixture anchor='game' mode='before-roll' locale={LOCALE.KO} feedback={feedback} />,
  );
  expect(screen.getByText('YOUR TURN').closest('[data-turn-cue]')).toBe(cue);
  expect(cue?.getAttribute('style')).toContain('-350ms');
  rerender(
    <VisualFixture
      anchor='game'
      mode='before-roll'
      locale={LOCALE.KO}
      feedback={{ ...feedback, elapsed: 500 }}
    />,
  );
  expect(screen.getByText('YOUR TURN').closest('[data-turn-cue]')).toBe(cue);
  expect(cue?.getAttribute('style')).toContain('-500ms');
  rerender(
    <VisualFixture
      anchor='game'
      mode='before-roll'
      locale={LOCALE.KO}
      feedback={{ ...feedback, elapsed: 650 }}
    />,
  );
  expect(screen.queryByText('YOUR TURN')).toBeNull();
  rerender(
    <VisualFixture
      anchor='game'
      mode='before-roll'
      locale={LOCALE.EN}
      feedback={{ ...feedback, elapsed: 100 }}
    />,
  );
  expect(screen.getByText('YOUR TURN').closest('[data-turn-cue]')?.getAttribute('style')).toContain(
    '-100ms',
  );
});
