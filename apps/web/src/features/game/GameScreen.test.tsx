// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- explicit cleanup prevents pending external-store updates from crossing tests. */

import type { ClientError } from '@repo/game-client-sdk/errors';
import {
  type CommandResult,
  createGameSession,
  type CreateGameSessionOptions,
} from '@repo/game-client-sdk/session';
import {
  CATEGORY_ID,
  type GameSnapshot,
  type GameSnapshotInput,
  parsePresenceSnapshot,
  parsePublicRoom,
  parseRoomView,
  type PublicRoom,
  type ResolvedRollArtifact,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { CATEGORY_IDS } from '@repo/yacht-rules';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import GameScreen from '@/features/game/GameScreen';
import { LOCALE, translate } from '@/i18n';
import { startGameAudioFeedback } from '@/runtime/audio/game-audio-feedback';
import { PRODUCT_CUE } from '@/runtime/audio/product-cues';
import { createDicePresentation } from '@/runtime/dice/dice-presentation';
import type { RollPlayback } from '@/runtime/dice/replay';
import { createProductPreferences } from '@/runtime/preferences/product-preferences';
import { createGameSessionHolder } from '@/runtime/session/session-holder';
import {
  authority,
  commandSuccess,
  finishedGame,
  initialPlayingMatch,
  playingGameInput as playingGame,
  room,
} from '@/testing/game-fixtures';
import {
  createAudio,
  createGameSessionHarness,
  createPresentation,
  createRecovery,
  createSession,
  createStore,
  deferred,
} from '@/testing/game-harness';
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}));

// jsdom has no layout engine; positioning is verified in the browser fixture.
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      public observe(): void {}
      public disconnect(): void {}
    },
  );
});

const feedbackDisposers = new Set<() => void>();
afterEach(() => {
  feedbackDisposers.forEach((dispose) => dispose());
  feedbackDisposers.clear();
  cleanup();
  navigate.mockReset();
  vi.unstubAllGlobals();
});

const resultCases = [
  {
    label: 'normal viewer win',
    outcome: 'viewer-win',
    reason: 'scoresCompleted',
    reasonKind: null,
    reasonMessageKey: null,
    winnerSeatIndex: 0,
  },
  {
    label: 'normal draw',
    outcome: 'draw',
    reason: 'scoresCompleted',
    reasonKind: null,
    reasonMessageKey: null,
    winnerSeatIndex: null,
  },
  {
    label: 'explicit forfeit',
    outcome: 'opponent-win',
    reason: 'explicitForfeit',
    reasonKind: 'forfeit',
    reasonMessageKey: 'game.resultForfeit',
    winnerSeatIndex: 1,
  },
  {
    label: 'timeout limit',
    outcome: 'viewer-win',
    reason: 'timeoutLimit',
    reasonKind: 'timeout',
    reasonMessageKey: 'game.resultTimeout',
    winnerSeatIndex: 0,
  },
  {
    label: 'connection ended',
    outcome: 'opponent-win',
    reason: 'connectionEnded',
    reasonKind: 'connection-ended',
    reasonMessageKey: 'game.resultConnectionEnded',
    winnerSeatIndex: 1,
  },
] as const;

function createHarness(
  game: GameSnapshotInput | GameSnapshot = playingGame,
  serverNow: number | null = 10_000,
  presentedRoom: PublicRoom = room,
) {
  let currentServerNow = serverNow;
  const harness = {
    ...createGameSessionHarness(game, presentedRoom),
    audio: createAudio(),
    clock: { now: () => currentServerNow },
    store: createStore(),
    preferences: createProductPreferences({ getItem: () => null, setItem: () => undefined }),
    presentation: createPresentation(),
    recovery: createRecovery(),
    setServerNow(next: number | null) {
      currentServerNow = next;
    },
  };
  harness.preferences.setLocale(LOCALE.EN);
  const feedback = startGameAudioFeedback(harness);
  feedbackDisposers.add(feedback.dispose);
  return { ...harness, feedback };
}

function getViewerSummary(): HTMLElement {
  return screen.getByText(
    (_content, element) => element?.getAttribute('data-game-band') === 'summary',
  );
}

function getPreviewScoreButtons(): HTMLElement[] {
  return screen
    .getAllByRole('button', { hidden: true })
    .filter((button) => button.getAttribute('data-value-state') === 'preview');
}

function getLowerScoreTab(): HTMLElement {
  const tab = screen
    .getAllByRole('tab', { hidden: true })
    .find((candidate) => candidate.getAttribute('data-score-tab') === 'lower');
  if (!tab) throw new Error('Expected the lower score tab');
  return tab;
}

test('starts on upper scores and preserves the selected tab across game updates', () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  expect(screen.getByRole('tab', { selected: true }).getAttribute('data-score-tab')).toBe('upper');
  fireEvent.click(getLowerScoreTab());
  expect(getLowerScoreTab().getAttribute('aria-selected')).toBe('true');

  act(() => harness.sessions.publish({ ...playingGame, stateVersion: 8 }));
  expect(getLowerScoreTab().getAttribute('aria-selected')).toBe('true');
});

test('emphasizes each authoritative viewer turn once across updates and session replacement', () => {
  vi.useFakeTimers();
  try {
    const harness = createHarness();
    const view = render(
      <StrictMode>
        <GameScreen {...harness} locale={LOCALE.EN} />
      </StrictMode>,
    );

    expect(getViewerSummary().getAttribute('data-summary-emphasized')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(getViewerSummary().getAttribute('data-summary-emphasized')).toBe('false');

    act(() => {
      harness.sessions.publish({
        ...playingGame,
        stateVersion: 8,
        match: {
          ...initialPlayingMatch,
          currentTurn: { ...initialPlayingMatch.currentTurn, rollCount: 2 },
        },
      } satisfies GameSnapshotInput);
      harness.sessions.replaceSession(createSession());
    });
    expect(getViewerSummary().getAttribute('data-summary-emphasized')).toBe('false');

    act(() => {
      const nextRoom = parsePublicRoom({
        ...room,
        roomId: '019976a2-d8d8-7000-8000-000000000002',
      });
      const nextView = parseRoomView({
        room: nextRoom,
        game: playingGame,
        presence: {
          roomId: nextRoom.roomId,
          presenceVersion: 1,
          seats: [{ status: 'connected' }, { status: 'connected' }],
        },
      });
      harness.sessions.replaceSession(
        createSession({ ...harness.session.getSnapshot(), ...nextView }),
        { ...authority, roomId: nextRoom.roomId },
      );
    });
    expect(getViewerSummary().getAttribute('data-summary-emphasized')).toBe('true');
    act(() => {
      vi.advanceTimersByTime(300);
    });

    act(() => {
      harness.sessions.publish({
        ...playingGame,
        stateVersion: 9,
        match: {
          ...initialPlayingMatch,
          currentTurn: {
            ...initialPlayingMatch.currentTurn,
            turnId: '11111111-1111-4111-8111-000000000002',
            seatIndex: 1,
          },
        },
      } satisfies GameSnapshotInput);
    });
    expect(getViewerSummary().getAttribute('data-summary-emphasized')).toBe('false');

    act(() => {
      harness.sessions.publish({
        ...playingGame,
        stateVersion: 10,
        match: {
          ...initialPlayingMatch,
          currentTurn: {
            ...initialPlayingMatch.currentTurn,
            turnId: '11111111-1111-4111-8111-000000000003',
          },
        },
      } satisfies GameSnapshotInput);
    });
    expect(getViewerSummary().getAttribute('data-summary-emphasized')).toBe('true');

    act(() => harness.sessions.publish(finishedGame('scoresCompleted', 0)));
    expect(
      screen.queryByText(
        (_content, element) => element?.getAttribute('data-player-summary') === 'viewer',
      ),
    ).toBeNull();
    view.unmount();
    harness.feedback.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test('does not replay a consumed turn after the scoreboard remounts the board', () => {
  vi.useFakeTimers();
  try {
    const harness = createHarness();
    render(
      <StrictMode>
        <GameScreen {...harness} locale={LOCALE.EN} />
      </StrictMode>,
    );

    expect(getViewerSummary().getAttribute('data-summary-emphasized')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(getViewerSummary().getAttribute('data-summary-emphasized')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
    act(() => {
      harness.sessions.publish({
        ...playingGame,
        stateVersion: 8,
        match: {
          ...initialPlayingMatch,
          currentTurn: {
            ...initialPlayingMatch.currentTurn,
            turnId: '11111111-1111-4111-8111-000000000002',
          },
        },
      } satisfies GameSnapshotInput);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(getViewerSummary().getAttribute('data-summary-emphasized')).toBe('true');
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test.each([null, 61_000])(
  'keeps commands locked for unavailable or expired server time %s',
  (serverNow) => {
    const harness = createHarness(playingGame, serverNow);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);

    const rollButton = screen.getByRole('button', { name: 'Roll again' });
    expect(rollButton.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(rollButton);
    fireEvent.click(screen.getByRole('button', { name: 'Dice area 1: 2' }));
    fireEvent.click(getPreviewScoreButtons()[0]!);
    expect(harness.session.rollDice).not.toHaveBeenCalled();
    expect(harness.session.setDieHeld).not.toHaveBeenCalled();
    expect(harness.session.selectScoreCategory).not.toHaveBeenCalled();
  },
);

test('shows a confirm-only rate-limit notice over the retained Settings layer without replaying', async () => {
  const forfeit = deferred<CommandResult>();
  const harness = createHarness();
  vi.mocked(harness.session.forfeitMatch).mockReturnValueOnce(forfeit.promise);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'settings.title') }));
  const settingsHeading = screen.getByRole('heading', {
    name: translate(LOCALE.EN, 'settings.title'),
  });
  const interactionSurface = screen.getByRole('group', { name: 'Game' });
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'game.forfeitAction') }));
  await act(async () =>
    forfeit.resolve({
      ok: false,
      error: {
        kind: 'server',
        error: { code: 'RATE_LIMITED', params: { retryAfterMs: 1_501 } },
      },
    }),
  );

  const notice = screen.getByRole('alertdialog', {
    name: translate(LOCALE.EN, 'common.noticeTitle'),
  });
  expect(within(notice).getByText(translate(LOCALE.EN, 'error.rateLimited'))).not.toBeNull();
  expect(interactionSurface.getAttribute('inert')).toBe('');
  expect(screen.getByRole('heading', { name: 'Settings', hidden: true })).toBe(settingsHeading);

  fireEvent.click(
    within(notice).getByRole('button', { name: translate(LOCALE.EN, 'common.confirm') }),
  );

  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Settings' })).toBe(settingsHeading);
  expect(harness.session.forfeitMatch).toHaveBeenCalledOnce();
});

test('keeps the authoritative turn timer running behind a rate-limit notice', async () => {
  vi.useFakeTimers();
  try {
    const harness = createHarness();
    render(<GameScreen {...harness} locale={LOCALE.EN} />);

    fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
    await act(async () =>
      harness.roll.resolve({
        ok: false,
        error: {
          kind: 'server',
          error: { code: 'RATE_LIMITED', params: { retryAfterMs: 2_000 } },
        },
      }),
    );
    expect(screen.getByRole('alertdialog')).not.toBeNull();
    expect(screen.getByText('51s')).not.toBeNull();

    act(() => {
      harness.setServerNow(11_000);
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText('50s')).not.toBeNull();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test('ignores a late rate-limit result from a replaced session or unmounted Game', async () => {
  const replaced = createHarness();
  const { unmount: unmountReplaced } = render(<GameScreen {...replaced} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  act(() => replaced.sessions.replaceSession(createSession()));
  await act(async () =>
    replaced.roll.resolve({
      ok: false,
      error: {
        kind: 'server',
        error: { code: 'RATE_LIMITED', params: { retryAfterMs: 1_000 } },
      },
    }),
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  unmountReplaced();

  const unmounted = createHarness();
  const { unmount } = render(<GameScreen {...unmounted} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  unmount();
  await act(async () =>
    unmounted.roll.resolve({
      ok: false,
      error: {
        kind: 'server',
        error: { code: 'RATE_LIMITED', params: { retryAfterMs: 1_000 } },
      },
    }),
  );
  expect(unmounted.recovery.reportCommandError).not.toHaveBeenCalled();
});

test('removes the rate-limit notice when an authoritative Result arrives', async () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  await act(async () =>
    harness.roll.resolve({
      ok: false,
      error: {
        kind: 'server',
        error: { code: 'RATE_LIMITED', params: { retryAfterMs: 1_000 } },
      },
    }),
  );
  expect(screen.getByRole('alertdialog')).not.toBeNull();

  act(() => harness.sessions.publish(finishedGame('scoresCompleted', 0)));

  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByRole('main').getAttribute('data-result-outcome')).toBe('viewer-win');
});

test('gives terminal recovery precedence over an open rate-limit notice', async () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  await act(async () =>
    harness.roll.resolve({
      ok: false,
      error: {
        kind: 'server',
        error: { code: 'RATE_LIMITED', params: { retryAfterMs: 1_000 } },
      },
    }),
  );
  expect(screen.getByText(translate(LOCALE.EN, 'error.rateLimited'))).not.toBeNull();

  act(() => {
    harness.recovery.publish({
      status: 'permanentFailure',
      error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } },
    });
  });

  const terminal = screen.getByRole('alertdialog');
  expect(terminal.getAttribute('data-game-recovery-terminal')).toBe('permanentFailure');
  expect(screen.queryByText(translate(LOCALE.EN, 'error.rateLimited'))).toBeNull();
});

test('retries an eligible failure only through its captured SDK capability', async () => {
  const harness = createHarness();
  const firstRetryResult = deferred<CommandResult>();
  const firstRetry = vi.fn(() => firstRetryResult.promise);
  const secondRetry = vi.fn(async () => {
    harness.sessions.publish({ ...playingGame, stateVersion: 8 });
    return commandSuccess();
  });
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  await act(async () =>
    harness.roll.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'INTERNAL_ERROR', params: {} } },
      retry: { isAvailable: () => true, run: firstRetry },
    }),
  );

  const firstNotice = screen.getByRole('alertdialog', {
    name: translate(LOCALE.EN, 'common.noticeTitle'),
  });
  expect(within(firstNotice).getByText(translate(LOCALE.EN, 'error.internal'))).not.toBeNull();
  const firstRetryButton = within(firstNotice).getByRole('button', {
    name: translate(LOCALE.EN, 'common.retry'),
  });
  vi.mocked(harness.audio.playCue).mockClear();
  fireEvent.click(firstRetryButton);
  fireEvent.click(firstRetryButton);
  expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.CLICK);
  expect(firstRetry).toHaveBeenCalledOnce();
  expect(harness.session.rollDice).toHaveBeenCalledOnce();

  await act(async () =>
    firstRetryResult.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'ROLL_UNAVAILABLE', params: {} } },
      retry: { isAvailable: () => true, run: secondRetry },
    }),
  );
  const secondNotice = screen.getByRole('alertdialog', {
    name: translate(LOCALE.EN, 'common.noticeTitle'),
  });
  expect(
    within(secondNotice).getByText(translate(LOCALE.EN, 'error.rollUnavailable')),
  ).not.toBeNull();
  fireEvent.click(
    within(secondNotice).getByRole('button', { name: translate(LOCALE.EN, 'common.retry') }),
  );

  await waitFor(() => expect(secondRetry).toHaveBeenCalledOnce());
  expect(harness.session.rollDice).toHaveBeenCalledOnce();
});

test('delegates a command rejection without an SDK retry capability to recovery', async () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  await act(async () =>
    harness.roll.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'NOT_YOUR_TURN', params: {} } },
    }),
  );

  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(harness.recovery.reportCommandError).toHaveBeenCalledWith({
    kind: 'server',
    error: { code: 'NOT_YOUR_TURN', params: {} },
  });
});

test('clears a retry notice when terminal recovery takes priority', async () => {
  const retry = vi.fn(() => Promise.resolve(commandSuccess(playingGame.stateVersion)));
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  await act(async () =>
    harness.roll.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'INTERNAL_ERROR', params: {} } },
      retry: { isAvailable: () => true, run: retry },
    }),
  );
  expect(screen.getByText(translate(LOCALE.EN, 'error.internal'))).not.toBeNull();

  act(() => {
    harness.recovery.publish({
      status: 'permanentFailure',
      error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } },
    });
  });
  expect(screen.getByRole('alertdialog').getAttribute('data-game-recovery-terminal')).toBe(
    'permanentFailure',
  );
  expect(screen.queryByText(translate(LOCALE.EN, 'error.internal'))).toBeNull();

  act(() => harness.recovery.publish({ status: 'idle' }));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(retry).not.toHaveBeenCalled();
});

test('does not resurrect retry UI after session replacement or an authoritative Result', async () => {
  const retryResult = deferred<CommandResult>();
  const retry = vi.fn(() => retryResult.promise);
  const freshRetry = vi.fn(() => Promise.resolve(commandSuccess(playingGame.stateVersion)));
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  await act(async () =>
    harness.roll.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'INTERNAL_ERROR', params: {} } },
      retry: { isAvailable: () => true, run: retry },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'common.retry') }));
  act(() => harness.sessions.replaceSession(createSession()));
  await act(async () =>
    retryResult.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'ROLL_UNAVAILABLE', params: {} } },
      retry: { isAvailable: () => true, run: freshRetry },
    }),
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(freshRetry).not.toHaveBeenCalled();

  const finishedHarness = createHarness();
  cleanup();
  render(<GameScreen {...finishedHarness} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  await act(async () =>
    finishedHarness.roll.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'INTERNAL_ERROR', params: {} } },
      retry: { isAvailable: () => true, run: freshRetry },
    }),
  );
  expect(screen.getByRole('alertdialog')).not.toBeNull();

  act(() => finishedHarness.sessions.publish(finishedGame('scoresCompleted', 0)));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.getByRole('main').getAttribute('data-result-outcome')).toBe('viewer-win');
});

test('projects authoritative dice and sends guarded roll, hold, and score commands', async () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  expect(screen.getByRole('heading', { name: 'Game' })).not.toBeNull();
  const firstSettledDie = screen.getByRole('button', { name: 'Dice area 1: 2' });
  expect(firstSettledDie.getAttribute('data-settled-slot')).toBe('0');
  expect(firstSettledDie.getAttribute('data-authoritative-die-slot')).toBe('0');
  expect(firstSettledDie.getAttribute('data-die-face')).toBe('2');
  expect(firstSettledDie.tabIndex).toBe(0);
  expect(screen.queryByLabelText('Dice area 2: 3')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
  const scoreTable = screen.getByRole('table');
  expect(
    within(scoreTable)
      .getAllByRole('row')
      .filter((row) => row.hasAttribute('data-score-category'))
      .map((row) => row.getAttribute('data-score-category')),
  ).toEqual(CATEGORY_IDS);
  expect(screen.getByRole('row', { name: /Ones 2 1/u })).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));

  vi.mocked(harness.audio.playCue).mockClear();
  const rollButton = screen.getByRole('button', { name: 'Roll again' });
  fireEvent.click(rollButton);
  fireEvent.click(rollButton);
  expect(harness.session.rollDice).toHaveBeenCalledOnce();
  expect(harness.audio.playCue).toHaveBeenCalledOnce();
  expect(harness.audio.playCue).toHaveBeenCalledWith(PRODUCT_CUE.ROLL_CLICK);

  fireEvent.click(screen.getByRole('button', { name: 'Dice area 1: 2' }));
  expect(harness.session.setDieHeld).not.toHaveBeenCalled();

  await act(async () => {
    harness.sessions.publish({
      ...playingGame,
      stateVersion: 8,
    } satisfies GameSnapshotInput);
    harness.roll.resolve(commandSuccess());
  });
  fireEvent.click(screen.getByRole('button', { name: 'Dice area 1: 2' }));
  expect(harness.session.setDieHeld).toHaveBeenCalledWith(0, true);

  await act(async () => Promise.resolve());
  fireEvent.click(screen.getByRole('button', { name: 'Dice controls 2: 3' }));
  expect(harness.session.setDieHeld).toHaveBeenLastCalledWith(1, false);

  await act(async () => Promise.resolve());
  fireEvent.click(screen.getByRole('tab', { name: /Upper/u }));
  fireEvent.click(screen.getByRole('button', { name: /Twos/u }));
  expect(harness.session.selectScoreCategory).toHaveBeenCalledWith('twos');
});

test.each([
  [LOCALE.KO, '주사위 영역 4: 5', '주사위 조작 4: 5'],
  [LOCALE.EN, 'Dice area 4: 5', 'Dice controls 4: 5'],
] as const)(
  'preserves slot and face in accessible dice names before and after hold in %s',
  async (locale, settledName, heldName) => {
    const harness = createHarness();
    render(<GameScreen {...harness} locale={locale} />);

    const settledDie = screen.getByRole('button', { name: settledName });
    expect(settledDie.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(settledDie);
    expect(harness.session.setDieHeld).toHaveBeenCalledWith(3, true);

    await act(async () => {
      harness.sessions.publish({
        ...playingGame,
        stateVersion: 8,
        match: {
          ...initialPlayingMatch,
          currentTurn: { ...initialPlayingMatch.currentTurn, heldSlots: [1, 3] },
        },
      });
    });

    const heldDie = screen.getByRole('button', { name: heldName, pressed: true });
    expect(heldDie.hasAttribute('disabled')).toBe(false);
    expect(
      screen
        .getAllByRole('button', { pressed: true })
        .map((die) => die.getAttribute('data-held-slot')),
    ).toEqual(['1', '3']);
    expect(screen.queryByRole('button', { name: settledName })).toBeNull();

    fireEvent.click(heldDie);
    expect(harness.session.setDieHeld).toHaveBeenLastCalledWith(3, false);
    expect(heldDie.hasAttribute('disabled')).toBe(true);
    expect(heldDie.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      harness.sessions.publish({ ...playingGame, stateVersion: 9 });
    });
    expect(screen.queryByRole('button', { name: heldName })).toBeNull();
    expect(screen.getByRole('button', { name: settledName, pressed: false })).not.toBeNull();
  },
);

test.each([false, true])(
  'keeps scoring available with all dice held (restored: %s)',
  async (restored) => {
    const dice = initialPlayingMatch.currentTurn.dice!;
    const allHeld: GameSnapshotInput = {
      ...playingGame,
      match: {
        ...initialPlayingMatch,
        currentTurn: {
          ...initialPlayingMatch.currentTurn,
          rollCount: 1,
          heldSlots: [0, 1, 2, 3, 4],
          dice,
        },
      },
    };
    const harness = createHarness(restored ? allHeld : playingGame);
    const presentation = createDicePresentation({
      sessions: harness.sessions,
      playCue: vi.fn(),
      requestSynchronization: vi.fn(),
      requireRefreshAfterSynchronization: vi.fn(),
    });
    presentation.start();
    try {
      render(<GameScreen {...harness} presentation={presentation} locale={LOCALE.EN} />);
      if (!restored) act(() => harness.sessions.publish(allHeld));

      expect(presentation.getSnapshot()).toMatchObject({ phase: 'settled', dice: [] });
      expect(getPreviewScoreButtons().length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Roll again' }).getAttribute('aria-disabled')).toBe(
        'true',
      );
      fireEvent.click(screen.getByRole('tab', { name: /Upper/u }));
      fireEvent.click(screen.getByRole('button', { name: /Twos/u }));
      expect(harness.session.selectScoreCategory).toHaveBeenCalledWith('twos');
      await act(async () => Promise.resolve());
    } finally {
      presentation.dispose();
    }
  },
);

test('explains a recorded category without sending another score command', () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  fireEvent.click(screen.getByRole('tab', { name: /Upper/u }));
  const recorded = screen.getByRole('button', { name: /Ones/u });
  expect(recorded.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(recorded);

  expect(harness.session.selectScoreCategory).not.toHaveBeenCalled();
  const notice = screen.getByRole('alertdialog', { name: 'Category already scored' });
  expect(notice.getAttribute('aria-modal')).toBe('true');
  fireEvent.click(within(notice).getByRole('button', { name: 'OK' }));
  expect(screen.queryByRole('alertdialog', { name: 'Category already scored' })).toBeNull();
});

test('gives recovery precedence over an open recorded category notice', () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  fireEvent.click(screen.getByRole('tab', { name: /Upper/u }));
  fireEvent.click(screen.getByRole('button', { name: /Ones/u }));
  expect(screen.getByRole('alertdialog', { name: 'Category already scored' })).not.toBeNull();

  act(() => {
    harness.recovery.publish({ status: 'reconnecting' });
  });
  expect(screen.queryByRole('alertdialog', { name: 'Category already scored' })).toBeNull();
  expect(screen.getByRole('status').getAttribute('data-game-recovery-overlay')).toBe(
    'reconnecting',
  );

  act(() => {
    harness.recovery.publish({ status: 'idle' });
  });
  expect(screen.queryByRole('alertdialog', { name: 'Category already scored' })).toBeNull();
});

test('labels total and bonus as one contextual player summary', () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  expect(screen.getByRole('group', { name: 'Total 2 · Bonus not earned' })).not.toBeNull();
});

test('updates bonus achievement with the authoritative score and the current turn player', () => {
  const belowBonusGame = {
    ...playingGame,
    match: {
      ...initialPlayingMatch,
      players: [
        {
          ...initialPlayingMatch.players[0],
          scorecard: { twos: 6, threes: 12, fours: 16, fives: 10, sixes: 18 },
        },
        initialPlayingMatch.players[1],
      ],
    },
  } satisfies GameSnapshotInput;
  const harness = createHarness(belowBonusGame);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  const bonusAction = screen.getByRole('button', { name: 'Bonus rule' });
  expect(screen.getByRole('group', { name: 'Total 62 · Bonus not earned' })).not.toBeNull();
  expect(bonusAction.textContent).toBe('Bonus');
  expect(screen.getByRole('button', { name: 'Bonus rule', description: 'Bonus not earned' })).toBe(
    bonusAction,
  );

  const achieved = {
    ...belowBonusGame,
    stateVersion: belowBonusGame.stateVersion + 1,
    match: {
      ...belowBonusGame.match,
      players: [
        {
          ...belowBonusGame.match.players[0],
          scorecard: { ...belowBonusGame.match.players[0].scorecard, ones: 1 },
        },
        belowBonusGame.match.players[1],
      ],
    },
  } satisfies GameSnapshotInput;
  act(() => harness.sessions.publish(achieved));
  expect(screen.getByRole('group', { name: 'Total 98 · Bonus earned' })).not.toBeNull();
  expect(bonusAction.textContent).toBe('Bonus');
  expect(screen.getByRole('button', { name: 'Bonus rule', description: 'Bonus earned' })).toBe(
    bonusAction,
  );

  act(() =>
    harness.sessions.publish({
      ...achieved,
      stateVersion: achieved.stateVersion + 1,
      match: {
        ...achieved.match,
        currentTurn: {
          ...achieved.match.currentTurn,
          turnId: '11111111-1111-4111-8111-000000000002',
          seatIndex: 1,
          rollCount: 0,
          heldSlots: [],
          dice: null,
        },
      },
    } satisfies GameSnapshotInput),
  );
  expect(screen.getByRole('group', { name: 'Total 1 · Bonus not earned' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Bonus rule', description: 'Bonus not earned' })).toBe(
    bonusAction,
  );
});

test('locks gameplay and withholds score previews until physical presentation settles', () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  expect(getPreviewScoreButtons().length).toBeGreaterThan(0);

  act(() => {
    harness.presentation.publish({
      phase: 'resolving',
      rollId: 'roll-physical',
      resources: null,
      dice: [{ slot: 0, value: 2 }],
    });
  });
  const roll = screen.getByRole('button', { name: 'Roll again', hidden: true });
  const settledDie = screen.getByRole('button', { name: 'Dice area 1: 2' });
  expect(settledDie.hasAttribute('disabled')).toBe(true);
  fireEvent.click(settledDie);
  expect(harness.session.setDieHeld).not.toHaveBeenCalled();
  expect(roll.getAttribute('data-interaction-locked')).toBe('true');
  expect(roll.getAttribute('aria-disabled')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Roll again' })).toBeNull();
  expect(getPreviewScoreButtons()).toHaveLength(0);
  expect(getLowerScoreTab().textContent).toBe('Lower');
  fireEvent.click(roll);
  expect(harness.session.rollDice).not.toHaveBeenCalled();

  act(() => {
    harness.presentation.publish({
      phase: 'revealing',
      rollId: 'roll-physical',
      playback: {
        status: 'verified',
        rollId: 'roll-physical',
        // This screen test publishes presentation phases; it does not run physical replay.
        timeline: {
          rollId: 'roll-physical',
          seed: 'screen-phase',
          durationMs: 1_000,
          rollArea: { width: 10, depth: 10, aspectRatio: 1 },
          cup: {
            style: 'classic',
            shakeAmplitude: 1,
            shakeFrequency: 1,
            pourAtMs: 100,
            releaseAtMs: 200,
            exitAtMs: 300,
            innerWidth: 2,
            innerDepth: 2,
            innerHeight: 3,
            frames: [],
          },
          dice: [{ slot: 0, value: 2, frames: [] }],
        },
      },
      resources: null,
      dice: [{ slot: 0, value: 2 }],
    });
  });
  expect(getPreviewScoreButtons()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Roll again' })).toBeNull();

  act(() => {
    harness.presentation.publish({
      phase: 'achievement',
      rollId: 'roll-physical',
      resources: null,
      dice: [{ slot: 0, value: 2 }],
      achievement: { kind: 'other', categoryId: 'full-house' },
    });
  });
  const achievement = screen.getByRole('status');
  expect(within(achievement).getByText('Full House')).not.toBeNull();
  expect(achievement.getAttribute('data-achievement-kind')).toBe('other');
  expect(getPreviewScoreButtons()).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Roll again' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  expect(screen.getByRole('heading', { name: 'Settings' })).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));

  act(() => {
    harness.presentation.publish({
      phase: 'settled',
      resources: null,
      dice: [{ slot: 0, value: 2 }],
    });
  });
  expect(getPreviewScoreButtons().length).toBeGreaterThan(0);
  expect(getLowerScoreTab().textContent).toMatch(/^LowerMax \d+$/u);
  expect(screen.getByRole('button', { name: 'Roll again' })).not.toBeNull();

  act(() => {
    harness.presentation.publish({ phase: 'hidden', resources: null });
  });
  expect(getPreviewScoreButtons()).toHaveLength(0);
  expect(screen.getByRole('button', { name: 'Roll again' })).not.toBeNull();
});

test.each([
  { phase: 'resolving', rollId: 'settings-roll', resources: null, dice: [] },
  {
    phase: 'achievement',
    rollId: 'settings-roll',
    resources: null,
    dice: [],
    achievement: { kind: 'other', categoryId: 'full-house' },
  },
] as const)(
  'settings and forfeit remain usable during $phase, with a pending request guard',
  async (snapshot) => {
    const harness = createHarness();
    const response = deferred<CommandResult>();
    harness.session.forfeitMatch.mockReturnValue(response.promise);
    harness.presentation.publish(snapshot);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const forfeit = screen.getByRole('button', { name: 'Forfeit' });
    expect(forfeit.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(forfeit);
    expect(harness.session.forfeitMatch).toHaveBeenCalledOnce();
    expect(forfeit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(forfeit);
    expect(harness.session.forfeitMatch).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'Game result' })).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: 'Music' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Sound effects' }));
    fireEvent.click(screen.getByRole('button', { name: '한국어' }));
    expect(harness.preferences.getSnapshot()).toMatchObject({
      locale: LOCALE.KO,
      bgmEnabled: false,
      sfxEnabled: false,
    });
    expect(screen.getByRole('button', { name: '기권하기' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(harness.presentation.getSnapshot().phase).toBe(snapshot.phase);

    await act(async () => response.resolve(commandSuccess()));
    expect(screen.getByRole('button', { name: '기권하기' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
    expect(screen.queryByRole('heading', { name: 'Game result' })).toBeNull();
  },
);

test('warns on own-turn seconds while the screen stays mounted and excludes opponent turns', () => {
  if (playingGame.match.status !== 'playing') throw new Error('Expected a playing fixture');
  const playingMatch = playingGame.match;
  const harness = createHarness(playingGame, 55_000);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  expect(screen.getByText('6s').getAttribute('data-timer-warning')).toBe('false');

  act(() => {
    harness.setServerNow(56_000);
    harness.sessions.publish(playingGame);
  });
  expect(harness.audio.playCue).toHaveBeenCalledOnce();
  expect(harness.audio.playCue).toHaveBeenLastCalledWith(PRODUCT_CUE.TIMER_WARNING);
  expect(screen.getByText('5s').getAttribute('data-timer-warning')).toBe('true');

  act(() => {
    harness.setServerNow(60_000);
    harness.sessions.publish(playingGame);
  });
  expect(harness.audio.playCue).toHaveBeenCalledTimes(2);
  expect(screen.getByText('1s').getAttribute('data-timer-warning')).toBe('true');

  act(() => {
    harness.setServerNow(61_000);
    harness.sessions.publish(playingGame);
  });
  expect(harness.audio.playCue).toHaveBeenCalledTimes(2);
  expect(screen.getByText('0s').getAttribute('data-timer-warning')).toBe('true');

  act(() => {
    harness.sessions.publish({
      ...playingGame,
      stateVersion: 8,
      match: {
        ...playingMatch,
        currentTurn: {
          ...playingMatch.currentTurn,
          turnId: '11111111-1111-4111-8111-000000000002',
          seatIndex: 1,
          deadlineAt: 65_000,
        },
      },
    } satisfies GameSnapshotInput);
  });
  expect(harness.audio.playCue).toHaveBeenCalledTimes(2);
  expect(harness.audio.playCue).toHaveBeenLastCalledWith(PRODUCT_CUE.TIMER_WARNING);
  harness.feedback.dispose();
});

test('does not mark the timer warning without a server clock sample', () => {
  const harness = createHarness(playingGame, null);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  expect(screen.getByText('—s').getAttribute('data-timer-warning')).toBe('false');
});

test('shows authoritative upper progress and the fixed bonus award', () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  const bonusAction = screen.getByRole('button', { name: 'Bonus rule' });
  expect(bonusAction.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(bonusAction);
  expect(bonusAction.getAttribute('aria-expanded')).toBe('true');
  const dialog = screen.getByRole('dialog', { name: 'Bonus rule' });

  expect(within(dialog).getByText('2/63')).not.toBeNull();
  expect(within(dialog).getByText('+35')).not.toBeNull();
  fireEvent.click(bonusAction);
  expect(screen.queryByRole('dialog', { name: 'Bonus rule' })).toBeNull();
  expect(bonusAction.getAttribute('aria-expanded')).toBe('false');
});

test('releases bonus layout observers on close, locale replacement and unmount', () => {
  const active = new Set<object>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      public observe(): void {
        active.add(this);
      }
      public disconnect(): void {
        active.delete(this);
      }
    },
  );
  const harness = createHarness();
  const view = render(<GameScreen {...harness} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: 'Bonus rule' }));
  expect(active.size).toBe(1);
  view.rerender(<GameScreen {...harness} locale={LOCALE.KO} />);
  expect(active.size).toBe(1);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button'));
  expect(active.size).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.KO, 'game.bonusInfo') }));
  expect(active.size).toBe(1);
  view.unmount();
  expect(active.size).toBe(0);
});

test('closes bonus information explicitly or outside without clicking through to game input', () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  const bonusAction = screen.getByRole('button', { name: 'Bonus rule' });
  const rollAction = screen.getByRole('button', { name: 'Roll again' });
  fireEvent.click(bonusAction);
  fireEvent.click(rollAction);
  expect(harness.session.rollDice).not.toHaveBeenCalled();

  fireEvent.click(within(screen.getByRole('dialog', { name: 'Bonus rule' })).getByRole('button'));
  expect(screen.queryByRole('dialog', { name: 'Bonus rule' })).toBeNull();

  fireEvent.click(bonusAction);
  const outsideDismiss = screen.getByLabelText('Close', {
    selector: 'button.web-game-bonus-dismiss',
  });
  fireEvent.click(outsideDismiss);
  expect(screen.queryByRole('dialog', { name: 'Bonus rule' })).toBeNull();
});

test('keeps bonus information available during an ordinary command pending state', () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  fireEvent.click(screen.getByRole('button', { name: 'Bonus rule' }));

  expect(screen.getByRole('dialog', { name: 'Bonus rule' })).not.toBeNull();
  expect(screen.queryByText(translate(LOCALE.EN, 'lobby.reentryConnecting'))).toBeNull();
  expect(screen.queryByText(translate(LOCALE.EN, 'lobby.reentrySynchronizing'))).toBeNull();
});

test('keeps an open game layer mounted and the timer running while recovery locks interaction', () => {
  vi.useFakeTimers();
  try {
    const harness = createHarness();
    render(<GameScreen {...harness} locale={LOCALE.EN} />);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const settings = screen.getByRole('heading', { name: 'Settings' });
    const surface = screen.getByRole('group', { name: 'Game' });
    expect(screen.getByText('51s')).not.toBeNull();

    act(() => {
      harness.recovery.publish({ status: 'reconnecting' });
    });
    expect(surface.getAttribute('inert')).toBe('');
    expect(surface.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Settings', hidden: true })).toBe(settings);
    expect(screen.getByText(translate(LOCALE.EN, 'lobby.reentryConnecting')).textContent).toBe(
      translate(LOCALE.EN, 'lobby.reentryConnecting'),
    );

    act(() => {
      harness.setServerNow(11_000);
      vi.advanceTimersByTime(1_000);
      harness.recovery.publish({ status: 'synchronizing' });
    });
    expect(screen.getByText('50s')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Settings', hidden: true })).toBe(settings);
    expect(screen.getByRole('status').getAttribute('data-game-recovery-overlay')).toBe(
      'synchronizing',
    );

    act(() => {
      harness.recovery.publish({ status: 'idle' });
    });
    expect(surface.getAttribute('inert')).toBeNull();
    expect(surface.getAttribute('aria-hidden')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBe(settings);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test.each([LOCALE.KO, LOCALE.EN])(
  'does not announce the opponent’s first connection as a reconnection in %s',
  (locale) => {
    const harness = createHarness();
    const { sessionSnapshot } = harness.sessions.getSnapshot();
    harness.sessions.replaceSession(
      createSession({
        ...sessionSnapshot,
        presence: parsePresenceSnapshot({
          roomId: authority.roomId,
          presenceVersion: 1,
          seats: [{ status: 'connected' }, { status: 'disconnected', reconnectDeadlineAt: null }],
        }),
      }),
    );
    render(<GameScreen {...harness} locale={locale} />);

    expect.soft(screen.queryByText(translate(locale, 'game.opponentDisconnected'))).toBeNull();
    act(() => {
      harness.sessions.publishOpponentConnection(true);
    });
    expect(screen.queryByText(translate(locale, 'game.opponentReconnected'))).toBeNull();
  },
);

test('announces recovery of an opponent already disconnected when the screen mounts', () => {
  const harness = createHarness();
  harness.sessions.publishOpponentConnection(false);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  expect(screen.getByText(translate(LOCALE.EN, 'game.opponentDisconnected'))).not.toBeNull();
  act(() => {
    harness.sessions.publishOpponentConnection(true);
  });
  expect(screen.getByText(translate(LOCALE.EN, 'game.opponentReconnected'))).not.toBeNull();
});

test('shows opponent disconnect persistently and a reconnection notice for exactly two seconds', () => {
  vi.useFakeTimers();
  try {
    const harness = createHarness();
    render(<GameScreen {...harness} locale={LOCALE.EN} />);

    expect(screen.queryByText(translate(LOCALE.EN, 'game.opponentDisconnected'))).toBeNull();
    act(() => {
      harness.sessions.publishOpponentConnection(false);
    });
    expect(screen.getByText(translate(LOCALE.EN, 'game.opponentDisconnected'))).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText(translate(LOCALE.EN, 'game.opponentDisconnected'))).not.toBeNull();

    act(() => {
      harness.sessions.publishOpponentConnection(true);
    });
    expect(screen.getByText(translate(LOCALE.EN, 'game.opponentReconnected'))).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    act(() => {
      harness.sessions.publishOpponentConnection(false);
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByText(translate(LOCALE.EN, 'game.opponentDisconnected'))).not.toBeNull();

    act(() => {
      harness.sessions.publishOpponentConnection(true);
    });
    act(() => {
      vi.advanceTimersByTime(999);
      harness.sessions.publishOpponentConnection(true);
    });
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByText(translate(LOCALE.EN, 'game.opponentReconnected'))).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText(translate(LOCALE.EN, 'game.opponentReconnected'))).toBeNull();
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

test('clears current authority only from the permanent recovery terminal', async () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  act(() => {
    harness.recovery.publish({
      status: 'permanentFailure',
      error: { kind: 'server', error: { code: 'ROOM_NOT_FOUND', params: {} } },
    });
  });
  const terminal = screen.getByRole('alertdialog');
  expect(terminal.getAttribute('data-game-recovery-terminal')).toBe('permanentFailure');
  expect(within(terminal).getByText(translate(LOCALE.EN, 'error.gameNotFound'))).not.toBeNull();
  const confirm = within(terminal).getByRole('button', {
    name: translate(LOCALE.EN, 'common.confirm'),
  });
  fireEvent.click(confirm);
  fireEvent.click(confirm);

  expect(harness.store.removeRoom).toHaveBeenCalledOnce();
  expect(harness.store.removeRoom).toHaveBeenCalledWith(authority.roomId);
  await waitFor(() => {
    expect(harness.sessions.clear).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ to: '/lobby' });
  });
});

test.each<ClientError | null>([null, { kind: 'transport', code: 'SOCKET_DISCONNECTED' }])(
  'keeps authority intact and shows a stopped recovery notice for %j',
  (error) => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload });
    const harness = createHarness();
    render(<GameScreen {...harness} locale={LOCALE.EN} />);

    act(() => {
      harness.recovery.publish({ status: 'refreshRequired', error });
    });
    const terminal = screen.getByRole('alertdialog');
    expect(terminal.getAttribute('data-game-recovery-terminal')).toBe('refreshRequired');
    expect(within(terminal).getByText(translate(LOCALE.EN, 'lobby.reentryRefresh'))).not.toBeNull();
    fireEvent.click(within(terminal).getByRole('button', { name: 'Refresh' }));
    expect(reload).toHaveBeenCalledOnce();
    expect(harness.store.removeRoom).not.toHaveBeenCalled();
    expect(harness.sessions.clear).not.toHaveBeenCalled();
  },
);

test('keeps bonus information available during the opponent turn', () => {
  if (playingGame.match.status !== 'playing') throw new Error('Expected a playing fixture');
  const opponentTurn = {
    ...playingGame,
    match: {
      ...playingGame.match,
      currentTurn: { ...playingGame.match.currentTurn, seatIndex: 1 },
    },
  } satisfies GameSnapshotInput;
  const harness = createHarness(opponentTurn);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  expect(screen.getByRole('img', { name: 'Opponent' }).getAttribute('src')).toContain('variant');
  expect(screen.getByRole('group', { name: 'Total 1 · Bonus not earned' })).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Bonus rule' }));

  expect(
    within(screen.getByRole('dialog', { name: 'Bonus rule' })).getByText('1/63'),
  ).not.toBeNull();
});

test('detaches the authoritative Result from transport before returning to the lobby', async () => {
  const harness = createHarness();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Forfeit' }));
  expect(harness.session.forfeitMatch).toHaveBeenCalledOnce();
  expect(screen.queryByRole('heading', { name: 'Game result' })).toBeNull();

  act(() => {
    harness.sessions.publish({
      stateVersion: 8,
      match: {
        status: 'finished',
        players: playingGame.match.players,
        result: { reason: 'explicitForfeit', winnerSeatIndex: 1 },
      },
    } satisfies GameSnapshotInput);
  });

  expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
  await waitFor(() => expect(harness.session.dispose).toHaveBeenCalledOnce());
  await waitFor(() => expect(harness.store.removeRoom).toHaveBeenCalledWith(authority.roomId));
  expect(harness.sessions.clear).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'game.backToLobby') }));
  expect(harness.store.removeRoom).toHaveBeenCalledWith(authority.roomId);
  await waitFor(() => {
    expect(harness.sessions.clear).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ to: '/lobby' });
  });
});

test.each(resultCases)(
  'projects the authoritative $label Result semantics',
  ({ outcome, reason, reasonKind, reasonMessageKey, winnerSeatIndex }) => {
    const harness = createHarness(finishedGame(reason, winnerSeatIndex));

    render(<GameScreen {...harness} locale={LOCALE.EN} />);

    const result = screen.getByRole('main');
    expect(result.getAttribute('data-result-outcome')).toBe(outcome);
    expect(result.getAttribute('data-winner')).toBe(
      winnerSeatIndex === null ? 'none' : winnerSeatIndex === 0 ? 'viewer' : 'opponent',
    );
    expect(
      screen.queryAllByText(translate(LOCALE.EN, 'game.win'), {
        selector: '.score-table-player__heading strong',
      }),
    ).toHaveLength(winnerSeatIndex === null ? 0 : 1);
    if (reasonMessageKey !== null) {
      expect(
        screen.getByText(translate(LOCALE.EN, reasonMessageKey)).getAttribute('data-result-reason'),
      ).toBe(reasonKind);
    }
  },
);

test('keeps Result score identity independent of winner and omits Game controls', () => {
  const players: GameSnapshot['match']['players'] = [
    {
      scorecard: { ones: 0, threes: 9 },
      timeoutCount: 0,
    },
    {
      scorecard: { ones: 4 },
      timeoutCount: 0,
    },
  ];
  const harness = createHarness(finishedGame('explicitForfeit', 1, players));

  render(<GameScreen {...harness} locale={LOCALE.EN} />);

  const headers = screen.getAllByRole('columnheader');
  expect(headers.map((header) => header.textContent)).toEqual(['Category', 'You', 'Opponent']);
  expect(screen.getAllByRole('rowheader')).toHaveLength(12);

  const onesRow = screen.getAllByRole('row').find(
    (row) =>
      within(row).queryByRole('rowheader', {
        name: translate(LOCALE.EN, 'category.ones'),
      }) !== null,
  );
  if (onesRow === undefined) throw new Error('Aces score row was not rendered');
  const onesScores = within(onesRow).getAllByRole('cell');
  expect(onesScores.map((cell) => cell.textContent)).toEqual(['0', '4']);
  expect(onesScores.map((cell) => cell.getAttribute('data-score-state'))).toEqual([
    'recorded',
    'recorded',
  ]);

  const twosRow = screen.getAllByRole('row').find(
    (row) =>
      within(row).queryByRole('rowheader', {
        name: translate(LOCALE.EN, 'category.twos'),
      }) !== null,
  );
  if (twosRow === undefined) throw new Error('Deuces score row was not rendered');
  const twosScores = within(twosRow).getAllByRole('cell');
  expect(twosScores.map((cell) => cell.textContent)).toEqual(['—', '—']);
  expect(twosScores.map((cell) => cell.getAttribute('data-score-state'))).toEqual([
    'empty',
    'empty',
  ]);

  expect(screen.queryByRole('button', { name: 'Roll again' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Scoreboard' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
});

test('score confirmation belongs to the submitting player after the next-turn snapshot, only once', async () => {
  const harness = createHarness();
  const result = deferred<CommandResult>();
  vi.mocked(harness.session.selectScoreCategory).mockReturnValue(result.promise);
  const view = render(<GameScreen {...harness} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: /Twos/u }));
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  act(() => harness.sessions.publish(finishedGame('scoresCompleted', 0)));
  expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
  expect(harness.store.removeRoom).toHaveBeenCalledOnce();
  expect(harness.session.dispose).not.toHaveBeenCalled();
  await act(async () => result.resolve(commandSuccess()));
  expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
  expect(harness.session.dispose).toHaveBeenCalledOnce();
  view.unmount();
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  act(() => harness.sessions.publish(finishedGame('scoresCompleted', 0)));
  expect(harness.audio.playCue).toHaveBeenCalledTimes(1);
});

test.each(['ack-first', 'live-first', 'ack-timeout'] as const)(
  'the real SDK completes final score handling before Result teardown (%s)',
  async (order) => {
    const scores = Object.fromEntries(Object.values(CATEGORY_ID).map((category) => [category, 0]));
    const beforeScores = { ...scores };
    delete beforeScores.yacht;
    const playing = parseRoomView({
      room,
      presence: {
        roomId: authority.roomId,
        presenceVersion: 1,
        seats: [{ status: 'connected' }, { status: 'connected' }],
      },
      game: {
        ...playingGame,
        match: {
          ...initialPlayingMatch,
          players: [
            { scorecard: beforeScores, timeoutCount: 0 },
            { scorecard: scores, timeoutCount: 0 },
          ],
          currentTurn: {
            ...initialPlayingMatch.currentTurn,
            heldSlots: [],
            dice: Array.from({ length: 5 }, () => ({ value: 6 })),
          },
        },
      },
    });
    const finished = parseRoomView({
      ...playing,
      room: { ...room, status: 'finished', finishedAt: 10_000 },
      game: finishedGame('scoresCompleted', 0, [
        { scorecard: { ...scores, yacht: 50 }, timeoutCount: 0 },
        { scorecard: scores, timeoutCount: 0 },
      ]),
    });
    const meta = {
      requestId: '11111111-1111-4111-8111-000000000003',
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
      serverTime: 10_000,
    };
    type TestSocket = ReturnType<NonNullable<CreateGameSessionOptions['socketFactory']>['create']>;
    let synchronizationView = playing;
    const socket = {
      connect: vi.fn<TestSocket['connect']>(async (): Promise<void> => {
        socket.onConnected.mock.lastCall?.[0]();
      }),
      disconnect: vi.fn<TestSocket['disconnect']>(),
      dispose: vi.fn<TestSocket['dispose']>(),
      emitSync: vi.fn<TestSocket['emitSync']>((ack) =>
        ack({ ok: true, data: synchronizationView, meta }),
      ),
      emitCommand: vi.fn<TestSocket['emitCommand']>(),
      onConnected: vi.fn<TestSocket['onConnected']>(() => () => {}),
      onDisconnected: vi.fn<TestSocket['onDisconnected']>(() => () => {}),
      onReplaced: vi.fn<TestSocket['onReplaced']>(() => () => {}),
      onRoomUpdate: vi.fn<TestSocket['onRoomUpdate']>(() => () => {}),
      onConnectionError: vi.fn<TestSocket['onConnectionError']>(() => () => {}),
    } satisfies TestSocket;
    const sessions = createGameSessionHolder({
      createSession: (credentials) =>
        createGameSession({
          authority: credentials,
          contract: createCompatibilityContract('test-release'),
          socketUrl: 'https://game.example.test',
          socketFactory: { create: () => socket },
          retryPolicy: { acknowledgementTimeoutMs: 100, maximumAttempts: 1, retryDelayMs: 0 },
        }),
    });
    const session = sessions.installAuthority(authority);
    expect(await session.connect()).toEqual({ ok: true });
    const audio = createAudio();
    const recovery = createRecovery();
    const store = createStore();
    const preferences = createProductPreferences({ getItem: () => null, setItem: () => {} });
    const feedback = startGameAudioFeedback({
      audio,
      sessions,
      recovery,
      preferences,
      clock: { now: () => 10_000 },
    });
    feedbackDisposers.add(feedback.dispose);
    feedbackDisposers.add(sessions.dispose);
    const score = vi.spyOn(session, 'selectScoreCategory');
    render(
      <GameScreen
        audio={audio}
        feedback={feedback}
        recovery={recovery}
        sessions={sessions}
        store={store}
        preferences={preferences}
        presentation={createPresentation()}
        clock={{ now: () => 10_000 }}
        locale={LOCALE.EN}
      />,
    );
    fireEvent.click(getLowerScoreTab());
    audio.playCue.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Yacht/u }));
    const [command, acknowledge] = socket.emitCommand.mock.lastCall!;
    synchronizationView = finished;
    if (order !== 'ack-first') {
      act(() =>
        socket.onRoomUpdate.mock.lastCall?.[0]({ type: 'state:committed', view: finished }),
      );
      expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
      expect(store.removeRoom).toHaveBeenCalledOnce();
      expect(session.getSnapshot().connection).toBe('connected');
    }
    if (order === 'ack-timeout') {
      await act(async () => {
        await expect(score.mock.results[0]?.value).resolves.toMatchObject({
          ok: false,
          error: { kind: 'transport', code: 'ACK_TIMEOUT' },
        });
      });
      expect(audio.playCue).not.toHaveBeenCalled();
    } else {
      await act(async () => {
        acknowledge({
          ok: true,
          data: { receipt: { stateVersion: 8 }, view: finished },
          meta: {
            requestId: meta.requestId,
            gameProtocolVersion: GAME_PROTOCOL_VERSION,
            actionId: command.actionId,
          },
        });
      });
      await expect(score.mock.results[0]?.value).resolves.toEqual({
        ok: true,
        actionId: command.actionId,
        requestId: meta.requestId,
        data: { stateVersion: 8 },
      });
      expect(audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
    }
    expect(session.getSnapshot().connection).toBe('disposed');
    expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
    expect(store.removeRoom).toHaveBeenCalledOnce();
  },
);

test('score rejection produces neither click nor success cue', async () => {
  const harness = createHarness();
  vi.mocked(harness.session.selectScoreCategory).mockResolvedValue({
    ok: false,
    error: { kind: 'server', error: { code: 'STALE_TURN', params: {} } },
  });
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: /Twos/u }));
  await act(async () => Promise.resolve());
  expect(harness.audio.playCue).not.toHaveBeenCalled();
});

test.each(['failure', 'rejection'] as const)(
  'Result detaches after a pending score ends with %s without a success cue',
  async (outcome) => {
    const harness = createHarness();
    const response = deferred<CommandResult>();
    harness.session.selectScoreCategory.mockReturnValue(response.promise);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    fireEvent.click(screen.getByRole('button', { name: /Twos/u }));
    act(() => harness.sessions.publish(finishedGame('connectionEnded', 1)));
    expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
    expect(harness.session.dispose).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === 'failure')
        response.resolve({
          ok: false,
          error: { kind: 'server', error: { code: 'STALE_TURN', params: {} } },
        });
      else response.reject(new Error('Unexpected score failure'));
    });
    expect(harness.session.dispose).toHaveBeenCalledOnce();
    expect(harness.audio.playCue).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
  },
);

test('score click submits the category and plays SCORE once after the original receipt', async () => {
  const harness = createHarness();
  const response = deferred<CommandResult>();
  harness.session.selectScoreCategory.mockReturnValue(response.promise);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: /Twos/u }));
  expect(harness.session.selectScoreCategory).toHaveBeenCalledExactlyOnceWith(CATEGORY_ID.TWOS);
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  act(() => harness.sessions.publish({ ...playingGame, stateVersion: 8 }));
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  await act(async () => response.resolve(commandSuccess()));
  expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
  act(() => harness.sessions.publish({ ...playingGame, stateVersion: 8 }));
  expect(harness.audio.playCue).toHaveBeenCalledOnce();
});

test.each([
  { openBefore: false, returnAt: 1_000 },
  { openBefore: false, returnAt: 2_000 },
  { openBefore: true, returnAt: 1_000 },
])(
  'skips scoreboard achievement display without shortening its deadline: $openBefore / $returnAt',
  async ({ openBefore, returnAt }) => {
    vi.useFakeTimers();
    const harness = createHarness();
    const presentation = createDicePresentation({
      sessions: harness.sessions,
      playCue: harness.audio.playCue,
      requestSynchronization: vi.fn(),
      requireRefreshAfterSynchronization: vi.fn(),
      loadResolver: async () => async (artifact) =>
        ({
          status: 'verified',
          rollId: artifact.replay.rollId,
          // This screen test drives playback completion, without mounting the Canvas.
          timeline: {
            rollId: artifact.replay.rollId,
            seed: 'achievement-screen',
            durationMs: 1_000,
            cup: {
              style: 'classic',
              shakeAmplitude: 1,
              shakeFrequency: 1,
              pourAtMs: 100,
              releaseAtMs: 200,
              exitAtMs: 300,
              innerWidth: 2,
              innerDepth: 2,
              innerHeight: 3,
              frames: [],
            },
            dice: [],
            rollArea: { width: 10, depth: 10, aspectRatio: 1 },
          },
        }) satisfies RollPlayback,
    });
    await presentation.prepare();
    presentation.start();
    const yachtGame: GameSnapshotInput = {
      ...playingGame,
      stateVersion: Number(playingGame.stateVersion) + 1,
      match: {
        ...initialPlayingMatch,
        currentTurn: {
          ...initialPlayingMatch.currentTurn,
          heldSlots: [],
          dice: [{ value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }],
        },
      },
    };
    const showYacht = async (rollId: string) => {
      const artifact = {
        type: 'roll:resolved',
        replay: {
          rollId: rollId as ResolvedRollArtifact['replay']['rollId'],
          mode: 'seeded-physics',
          contract: createCompatibilityContract('test'),
          seed: 'achievement-test',
          pourStyle: 'classic',
          rolledSlots: [0, 1, 2, 3, 4],
        },
        outcome: { authoritativeValuesBySlot: [0, 1, 2, 3, 4].map((slot) => ({ slot, value: 6 })) },
        replayDigest: `sha256-q4-v2:${'a'.repeat(64)}`,
      } as ResolvedRollArtifact;
      await act(async () => harness.sessions.publish(yachtGame, artifact));
      act(() => presentation.completePlayback(rollId));
      act(() => {
        vi.advanceTimersByTime(360);
      });
      expect(presentation.getSnapshot().phase).toBe('achievement');
    };
    try {
      const view = render(
        <GameScreen {...harness} presentation={presentation} locale={LOCALE.EN} />,
      );
      if (openBefore) fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
      await showYacht('scoreboard-yacht');
      if (!openBefore) {
        expect(screen.getByRole('status').getAttribute('data-achievement-kind')).toBe('yacht');
        act(() => {
          vi.advanceTimersByTime(500);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
      }
      act(() => {
        vi.advanceTimersByTime(returnAt - (openBefore ? 0 : 500));
      });
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.queryByRole('status')).toBeNull();
      if (returnAt < 1_980) {
        expect(getPreviewScoreButtons()).toHaveLength(0);
        expect(screen.queryByRole('button', { name: 'Roll again' })).toBeNull();
        // Locale changes and repeated layer visits must not resurrect this roll.
        view.rerender(<GameScreen {...harness} presentation={presentation} locale={LOCALE.KO} />);
        fireEvent.click(screen.getByRole('button', { name: '점수판' }));
        fireEvent.click(screen.getByRole('button', { name: '닫기' }));
        expect(screen.queryByRole('status')).toBeNull();
        act(() => {
          vi.advanceTimersByTime(1_979 - returnAt);
        });
        expect(presentation.getSnapshot().phase).toBe('achievement');
        act(() => {
          vi.advanceTimersByTime(1);
        });
      }
      expect(presentation.getSnapshot().phase).toBe('settled');
      expect(getPreviewScoreButtons().length).toBeGreaterThan(0);
      view.rerender(<GameScreen {...harness} presentation={presentation} locale={LOCALE.EN} />);
      await showYacht('next-yacht');
      const next = screen.getByRole('status');
      expect(next.getAttribute('data-achievement-kind')).toBe('yacht');
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.getByRole('status')).toBe(next);
      expect(
        harness.audio.playCue.mock.calls.filter(([cue]) => cue === PRODUCT_CUE.ACHIEVEMENT_YACHT),
      ).toHaveLength(2);
    } finally {
      cleanup();
      presentation.dispose();
      vi.useRealTimers();
    }
  },
);
