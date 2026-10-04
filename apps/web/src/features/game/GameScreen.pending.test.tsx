// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- pending timers must stop before restoring the clock. */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import GameScreen from '@/features/game/GameScreen';
import { LOCALE, translate } from '@/i18n';
import { createProductPreferences } from '@/runtime/preferences/product-preferences';
import { commandSuccess } from '@/testing/game-fixtures';
import {
  createAudio,
  createGameSessionHarness,
  createPresentation,
  createRecovery,
  createStore,
} from '@/testing/game-harness';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

for (const locale of [LOCALE.KO, LOCALE.EN]) {
  test.each([599, 600])(
    'acknowledges a roll immediately and defers its spinner in ' +
      locale +
      ' when receipt arrives at %sms',
    async (receiptAt) => {
      vi.useFakeTimers();
      const harness = {
        ...createGameSessionHarness(),
        audio: createAudio(),
        feedback: { observeCommand: vi.fn() },
        clock: { now: () => 10_000 },
        store: createStore(),
        preferences: createProductPreferences({ getItem: () => null, setItem: () => undefined }),
        presentation: createPresentation(),
        recovery: createRecovery(),
      };
      try {
        render(<GameScreen {...harness} locale={locale} />);
        const label = translate(locale, 'game.reroll');
        const roll = screen.getByRole('button', { name: label });
        fireEvent.click(roll);
        expect(roll.getAttribute('aria-busy')).toBe('true');
        expect(roll.getAttribute('aria-disabled')).toBe('true');
        expect(within(roll).getByText(label).textContent).toBe(label);
        expect(within(roll).queryByRole('progressbar', { hidden: true })).toBeNull();
        fireEvent.click(roll);
        expect(harness.session.rollDice).toHaveBeenCalledOnce();
        act(() => {
          vi.advanceTimersByTime(599);
        });
        expect(within(roll).queryByRole('progressbar', { hidden: true })).toBeNull();
        if (receiptAt === 600) {
          act(() => {
            vi.advanceTimersByTime(1);
          });
          expect(
            within(roll).queryByRole('progressbar', { hidden: true })?.getAttribute('aria-hidden'),
          ).toBe('true');
          expect(screen.getByRole('button', { name: label })).toBe(roll);
        }
        await act(async () => {
          harness.roll.resolve(commandSuccess());
          await harness.roll.promise;
        });
        expect(roll.getAttribute('aria-busy')).toBeNull();
        expect(roll.getAttribute('aria-disabled')).toBe('false');
        expect(within(roll).queryByRole('progressbar', { hidden: true })).toBeNull();
        act(() => {
          vi.advanceTimersByTime(600);
        });
        expect(within(roll).queryByRole('progressbar', { hidden: true })).toBeNull();
        expect(screen.getByRole('button', { name: label })).toBe(roll);
      } finally {
        cleanup();
        vi.useRealTimers();
      }
    },
  );
}
