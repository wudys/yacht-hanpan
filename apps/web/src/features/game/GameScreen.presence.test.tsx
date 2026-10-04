// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- notice timers must stop before restoring the clock. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import GameScreen from '@/features/game/GameScreen';
import { LOCALE, translate } from '@/i18n';
import { createPreferencesStore } from '@/runtime/preferences/preferences-store';
import {
  createAudioMock,
  createGameSessionHarness,
  createPresentationFake,
  createRecoveryFake,
  createSessionCredentialStoreSpy,
  createSessionMock,
} from '@/testing/game-harness';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

function createHarness() {
  return {
    ...createGameSessionHarness(),
    audio: createAudioMock(),
    feedback: { observeCommand: vi.fn() },
    clock: { now: () => 10_000 },
    sessionCredentialStore: createSessionCredentialStoreSpy(),
    preferences: createPreferencesStore({ getItem: () => null, setItem: () => undefined }),
    presentation: createPresentationFake(),
    recovery: createRecoveryFake(),
  };
}

function withPresenceClock(
  run: (harness: ReturnType<typeof createHarness>, advance: (milliseconds: number) => void) => void,
) {
  vi.useFakeTimers();
  const harness = createHarness();
  const advance = (milliseconds: number) => {
    act(() => {
      vi.advanceTimersByTime(milliseconds);
    });
  };
  try {
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    run(harness, advance);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
}

test('preserves the reconnect notice deadline across a midway scoreboard visit', () => {
  withPresenceClock((harness, advance) => {
    act(() => harness.sessions.publishOpponentConnection(false));
    act(() => harness.sessions.publishOpponentConnection(true));
    const message = translate(LOCALE.EN, 'game.opponentReconnected');
    advance(600);
    fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
    advance(600);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByText(message)).not.toBeNull();
    advance(799);
    expect(screen.getByText(message)).not.toBeNull();
    advance(1);
    expect(screen.queryByText(message)).toBeNull();
  });
});

test('observes opponent disconnect and reconnect while the scoreboard is open', () => {
  withPresenceClock((harness, advance) => {
    fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
    act(() => harness.sessions.publishOpponentConnection(false));
    act(() => harness.sessions.publishOpponentConnection(true));
    advance(1_000);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const message = translate(LOCALE.EN, 'game.opponentReconnected');
    expect(screen.getByText(message)).not.toBeNull();
    advance(999);
    expect(screen.getByText(message)).not.toBeNull();
    advance(1);
    expect(screen.queryByText(message)).toBeNull();
  });
});

test('expires a reconnect notice while the scoreboard hides its display', () => {
  withPresenceClock((harness, advance) => {
    act(() => harness.sessions.publishOpponentConnection(false));
    act(() => harness.sessions.publishOpponentConnection(true));
    fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
    advance(2_000);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(translate(LOCALE.EN, 'game.opponentReconnected'))).toBeNull();
  });
});

test('resets a hidden reconnect notice when the session is replaced', () => {
  withPresenceClock((harness, advance) => {
    act(() => harness.sessions.publishOpponentConnection(false));
    act(() => harness.sessions.publishOpponentConnection(true));
    fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
    advance(1_000);
    act(() => harness.sessions.replaceSession(createSessionMock()));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const message = translate(LOCALE.EN, 'game.opponentReconnected');
    expect(screen.queryByText(message)).toBeNull();
    act(() => harness.sessions.publishOpponentConnection(false));
    act(() => harness.sessions.publishOpponentConnection(true));
    advance(1_000);
    expect(screen.getByText(message)).not.toBeNull();
    advance(999);
    expect(screen.getByText(message)).not.toBeNull();
    advance(1);
    expect(screen.queryByText(message)).toBeNull();
  });
});
