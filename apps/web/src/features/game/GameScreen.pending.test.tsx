// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- pending timers must stop before restoring the clock. */

import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import GameScreen from '@/features/game/GameScreen';
import { LOCALE, translate } from '@/i18n';
import { createPreferencesStore } from '@/runtime/preferences/preferences-store';
import { commandSuccess, finishedGame, initialPlayingMatch } from '@/testing/game-fixtures';
import {
  createAudioMock,
  createGameSessionHarness,
  createPresentationFake,
  createRecoveryFake,
  createSessionCredentialStoreSpy,
} from '@/testing/game-harness';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

for (const locale of [LOCALE.KO, LOCALE.EN]) {
  test.each([
    { receiptAt: 1, rejected: false },
    { receiptAt: 350, rejected: false },
    { receiptAt: 10_000, rejected: false },
    { receiptAt: 350, rejected: true },
  ])(
    'shows roll waiting immediately in ' + locale + ' until $receiptAt ms receipt ($rejected)',
    async ({ receiptAt, rejected }) => {
      vi.useFakeTimers();
      const harness = {
        ...createGameSessionHarness(),
        audio: createAudioMock(),
        feedback: { observeHoldReceipt: vi.fn() },
        clock: { now: () => 10_000 },
        sessionCredentialStore: createSessionCredentialStoreSpy(),
        preferences: createPreferencesStore({ getItem: () => null, setItem: () => undefined }),
        presentation: createPresentationFake(),
        recovery: createRecoveryFake(),
      };
      try {
        render(<GameScreen surfaceExposed={true} {...harness} locale={locale} />);
        const label = translate(locale, 'game.reroll');
        const roll = screen.getByRole('button', { name: label });
        fireEvent.click(roll);
        expect(roll.getAttribute('aria-busy')).toBe('true');
        expect(roll.getAttribute('aria-disabled')).toBe('true');
        expect(within(roll).getByText(label).textContent).toBe(label);
        expect(
          within(roll).getByRole('progressbar', { hidden: true }).getAttribute('aria-hidden'),
        ).toBe('true');
        fireEvent.click(roll);
        expect(harness.session.rollDice).toHaveBeenCalledOnce();
        act(() => {
          vi.advanceTimersByTime(receiptAt);
        });
        expect(within(roll).getByRole('progressbar', { hidden: true })).not.toBeNull();
        await act(async () => {
          harness.roll.resolve(
            rejected
              ? {
                  ok: false,
                  error: {
                    kind: 'server',
                    error: { code: PUBLIC_ERROR_CODE.STALE_TURN, params: {} },
                  },
                }
              : commandSuccess(),
          );
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

test('a pending roll follows the authoritative turn and never covers Result', async () => {
  const harness = {
    ...createGameSessionHarness(),
    audio: createAudioMock(),
    feedback: { observeHoldReceipt: vi.fn() },
    clock: { now: () => 10_000 },
    sessionCredentialStore: createSessionCredentialStoreSpy(),
    preferences: createPreferencesStore({ getItem: () => null, setItem: () => undefined }),
    presentation: createPresentationFake(),
    recovery: createRecoveryFake(),
  };
  try {
    render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
    fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
    act(() =>
      harness.sessions.publish({
        stateVersion: 8,
        match: {
          ...initialPlayingMatch,
          currentTurn: {
            ...initialPlayingMatch.currentTurn,
            turnId: '11111111-1111-4111-8111-000000000004',
            seatIndex: 1,
            startedAt: 9_000,
            deadlineAt: 99_000,
            rollCount: 0,
            heldSlots: [],
            dice: null,
          },
        },
      }),
    );
    expect(screen.queryByRole('button', { name: 'Roll again' })).toBeNull();
    const opponentTurn = screen.getByRole('status');
    expect(
      within(opponentTurn).getByText(translate(LOCALE.EN, 'game.opponentTurn')),
    ).not.toBeNull();
    expect(opponentTurn.getAttribute('aria-busy')).toBe('true');
    expect(within(opponentTurn).getByRole('progressbar', { hidden: true })).not.toBeNull();
    act(() => harness.sessions.publish(finishedGame('connectionEnded', 1)));
    expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
    expect(screen.queryByRole('progressbar', { hidden: true })).toBeNull();
    expect(harness.session.dispose).not.toHaveBeenCalled();
    await act(async () => harness.roll.resolve(commandSuccess()));
    expect(harness.session.dispose).toHaveBeenCalledOnce();
    expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
  } finally {
    cleanup();
  }
});
