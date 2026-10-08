// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- explicit cleanup prevents pending external-store updates from crossing tests. */

import type { ClientError } from '@repo/game-client-sdk/errors';
import type { CommandResult } from '@repo/game-client-sdk/session';
import {
  CATEGORY_ID,
  type GameSnapshot,
  type GameSnapshotInput,
  parsePresenceSnapshot,
  type PublicRoom,
  type ResolvedRollArtifact,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { CATEGORY_IDS } from '@repo/yacht-rules';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import GameScreen from '@/features/game/GameScreen';
import { LOCALE, translate } from '@/i18n';
import { PRODUCT_CUE } from '@/runtime/audio/cue-runtime';
import { startGameAudioFeedback } from '@/runtime/audio/game-audio-feedback';
import { createDicePresentation } from '@/runtime/dice/dice-presentation';
import type { RollPlayback } from '@/runtime/dice/replay';
import { createPreferencesStore } from '@/runtime/preferences/preferences-store';
import {
  authority,
  commandSuccess,
  finishedGame,
  initialPlayingMatch,
  playingGameInput as playingGame,
  room,
} from '@/testing/game-fixtures';
import {
  createAudioMock,
  createGameSessionHarness,
  createPresentationFake,
  createRecoveryFake,
  createSessionCredentialStoreSpy,
  createSessionMock,
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
    label: 'normal opponent win',
    outcome: 'opponent-win',
    reason: 'scoresCompleted',
    reasonKind: null,
    reasonMessageKey: null,
    winnerSeatIndex: 1,
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
    audio: createAudioMock(),
    clock: { now: () => currentServerNow },
    sessionCredentialStore: createSessionCredentialStoreSpy(),
    preferences: createPreferencesStore({ getItem: () => null, setItem: () => undefined }),
    presentation: createPresentationFake(),
    recovery: createRecoveryFake(),
    setServerNow(next: number | null) {
      currentServerNow = next;
    },
  };
  harness.preferences.setLocale(LOCALE.EN);
  const feedback = startGameAudioFeedback(harness);
  feedbackDisposers.add(feedback.dispose);
  return { ...harness, feedback };
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

test('shows opponent previews and maxima from their scorecard without accepting gameplay input', () => {
  const harness = createHarness({
    ...playingGame,
    match: {
      ...initialPlayingMatch,
      players: [
        { scorecard: { ones: 3, sixes: 18 }, timeoutCount: 0 },
        { scorecard: { yacht: 0 }, timeoutCount: 0 },
      ],
      currentTurn: {
        ...initialPlayingMatch.currentTurn,
        seatIndex: 1,
        rollCount: 1,
        heldSlots: [],
        dice: [{ value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }],
      },
    },
  });
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

  const zero = screen.getByRole('button', { name: 'Ones · 0' });
  const sixes = screen.getByRole('button', { name: 'Sixes · 30' });
  expect(zero.getAttribute('data-value-state')).toBe('preview');
  expect(zero.hasAttribute('disabled')).toBe(true);
  expect(sixes.getAttribute('data-input-available')).toBe('false');
  expect(screen.getByRole('tab', { name: 'UpperMax 30' })).not.toBeNull();
  expect(getLowerScoreTab().textContent).toBe('LowerMax 30');
  fireEvent.click(zero);
  fireEvent.click(sixes);
  fireEvent.click(screen.getByRole('button', { name: 'Dice area 1: 6' }));
  fireEvent.click(getLowerScoreTab());
  const yacht = screen.getByRole('button', { name: 'Yacht · 0' });
  expect(yacht.getAttribute('data-value-state')).toBe('recorded');
  fireEvent.click(yacht);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Roll again' })).toBeNull();
  expect(harness.session.selectScoreCategory).not.toHaveBeenCalled();
  expect(harness.session.setDieHeld).not.toHaveBeenCalled();
  expect(harness.session.rollDice).not.toHaveBeenCalled();
});

test('starts on upper scores and preserves the selected tab across game updates', () => {
  const harness = createHarness();
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

  expect(screen.getByRole('tab', { selected: true }).getAttribute('data-score-tab')).toBe('upper');
  fireEvent.click(getLowerScoreTab());
  expect(getLowerScoreTab().getAttribute('aria-selected')).toBe('true');

  act(() => harness.sessions.publish({ ...playingGame, stateVersion: 8 }));
  expect(getLowerScoreTab().getAttribute('aria-selected')).toBe('true');
});

test('settled snapshots do not infer a turn cue across updates, session replacement, or board remount', () => {
  const harness = createHarness();
  render(
    <StrictMode>
      <GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />
    </StrictMode>,
  );
  expect(screen.queryByText('YOUR TURN')).toBeNull();
  act(() => harness.sessions.replaceSession(createSessionMock()));
  expect(screen.queryByText('YOUR TURN')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
  act(() =>
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
    } satisfies GameSnapshotInput),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByText('YOUR TURN')).toBeNull();
});

test.each([null, 61_000])(
  'keeps commands locked for unavailable or expired server time %s',
  (serverNow) => {
    const harness = createHarness(playingGame, serverNow);
    render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
    render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  const { unmount: unmountReplaced } = render(
    <GameScreen surfaceExposed={true} {...replaced} locale={LOCALE.EN} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  act(() => replaced.sessions.replaceSession(createSessionMock()));
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
  const { unmount } = render(
    <GameScreen surfaceExposed={true} {...unmounted} locale={LOCALE.EN} />,
  );
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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

  fireEvent.click(screen.getByRole('button', { name: 'Roll again' }));
  await act(async () =>
    harness.roll.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'INTERNAL_ERROR', params: {} } },
      retry: { isAvailable: () => true, run: retry },
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'common.retry') }));
  act(() => harness.sessions.replaceSession(createSessionMock()));
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
  render(<GameScreen surfaceExposed={true} {...finishedHarness} locale={LOCALE.EN} />);
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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
    render(<GameScreen surfaceExposed={true} {...harness} locale={locale} />);

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
      render(
        <GameScreen
          surfaceExposed={true}
          {...harness}
          presentation={presentation}
          locale={LOCALE.EN}
        />,
      );
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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
    render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

  expect(screen.getByText('—s').getAttribute('data-timer-warning')).toBe('false');
});

test.each([61_000, null])(
  'locks commands on clock boundary %s without a session update',
  (serverNow) => {
    vi.useFakeTimers();
    try {
      const harness = createHarness(playingGame, 60_000);
      render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
      const roll = screen.getByRole('button', { name: 'Roll again' });
      const die = screen.getByRole('button', { name: 'Dice area 1: 2' });
      act(() => {
        harness.setServerNow(serverNow);
        vi.advanceTimersByTime(250);
      });
      expect(roll.getAttribute('aria-disabled')).toBe('true');
      expect(die.hasAttribute('disabled')).toBe(true);
      fireEvent.click(roll);
      fireEvent.click(die);
      fireEvent.click(getPreviewScoreButtons()[0]!);
      expect(harness.session.rollDice).not.toHaveBeenCalled();
      expect(harness.session.setDieHeld).not.toHaveBeenCalled();
      expect(harness.session.selectScoreCategory).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      const forfeit = screen.getByRole('button', { name: 'Forfeit' });
      expect(forfeit.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(forfeit);
      expect(harness.session.forfeitMatch).not.toHaveBeenCalled();
      act(() => {
        harness.setServerNow(60_000);
        vi.advanceTimersByTime(250);
      });
      expect(forfeit.getAttribute('aria-disabled')).toBe('false');
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(roll.getAttribute('aria-disabled')).toBe('false');
      fireEvent.click(die);
      expect(harness.session.setDieHeld).toHaveBeenCalledWith(0, true);
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  },
);

test.each([61_000, null])(
  'keeps a remounted timer and input gate consistent when its poll runs first: %s',
  (serverNow) => {
    vi.useFakeTimers();
    const polling = vi.spyOn(window, 'setInterval');
    try {
      const harness = createHarness(playingGame, 60_000);
      render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
      fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      const remountedTimerPoll = polling.mock.calls.at(-1)?.[0];
      if (typeof remountedTimerPoll !== 'function')
        throw new Error('Expected a timer poll callback');
      act(() => {
        harness.setServerNow(serverNow);
        remountedTimerPoll();
      });
      expect(screen.getByText(serverNow === null ? '—s' : '0s')).not.toBeNull();
      const roll = screen.getByRole('button', { name: 'Roll again' });
      expect(roll.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(roll);
      expect(harness.session.rollDice).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Dice area 1: 2' }).hasAttribute('disabled')).toBe(
        true,
      );
      fireEvent.click(getPreviewScoreButtons()[0]!);
      expect(harness.session.selectScoreCategory).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
      const forfeit = screen.getByRole('button', { name: 'Forfeit' });
      expect(forfeit.getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(forfeit);
      expect(harness.session.forfeitMatch).not.toHaveBeenCalled();
    } finally {
      polling.mockRestore();
      cleanup();
      vi.useRealTimers();
    }
  },
);

test('shows authoritative upper progress and the fixed bonus award', () => {
  const harness = createHarness();
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  const view = render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: 'Bonus rule' }));
  expect(active.size).toBe(1);
  view.rerender(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.KO} />);
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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
    render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
      createSessionMock({
        ...sessionSnapshot,
        presence: parsePresenceSnapshot({
          roomId: authority.roomId,
          presenceVersion: 1,
          seats: [{ status: 'connected' }, { status: 'disconnected', reconnectDeadlineAt: null }],
        }),
      }),
    );
    render(<GameScreen surfaceExposed={true} {...harness} locale={locale} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
    render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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

  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledWith(authority.roomId);
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
    render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

    act(() => {
      harness.recovery.publish({ status: 'refreshRequired', error });
    });
    const terminal = screen.getByRole('alertdialog');
    expect(terminal.getAttribute('data-game-recovery-terminal')).toBe('refreshRequired');
    expect(within(terminal).getByText(translate(LOCALE.EN, 'lobby.reentryRefresh'))).not.toBeNull();
    fireEvent.click(within(terminal).getByRole('button', { name: 'Refresh' }));
    expect(reload).toHaveBeenCalledOnce();
    expect(harness.sessionCredentialStore.removeRoom).not.toHaveBeenCalled();
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
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

  expect(screen.getByRole('img', { name: 'Opponent' }).getAttribute('src')).toContain('variant');
  expect(screen.getByRole('group', { name: 'Total 1 · Bonus not earned' })).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Bonus rule' }));

  expect(
    within(screen.getByRole('dialog', { name: 'Bonus rule' })).getByText('1/63'),
  ).not.toBeNull();
});

test('detaches the authoritative Result from transport before returning to the lobby', async () => {
  const harness = createHarness();
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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
  await waitFor(() =>
    expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledWith(authority.roomId),
  );
  expect(harness.sessions.clear).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: translate(LOCALE.EN, 'game.backToLobby') }));
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledWith(authority.roomId);
  await waitFor(() => {
    expect(harness.sessions.clear).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ to: '/lobby' });
  });
});

test.each(
  resultCases.flatMap((result) => [LOCALE.KO, LOCALE.EN].map((locale) => ({ ...result, locale }))),
)(
  'projects the authoritative $label Result semantics in $locale',
  ({ outcome, reason, reasonKind, reasonMessageKey, winnerSeatIndex, locale }) => {
    const harness = createHarness(finishedGame(reason, winnerSeatIndex));

    render(<GameScreen surfaceExposed={true} {...harness} locale={locale} />);

    const result = screen.getByRole('main');
    expect(
      screen.getByRole('heading', { name: translate(locale, 'game.view.result') }),
    ).not.toBeNull();
    expect(
      screen.getByRole('button', { name: translate(locale, 'game.backToLobby') }),
    ).not.toBeNull();
    expect(result.getAttribute('data-result-outcome')).toBe(outcome);
    expect(result.getAttribute('data-winner')).toBe(
      winnerSeatIndex === null ? 'none' : winnerSeatIndex === 0 ? 'viewer' : 'opponent',
    );
    for (const [player, seatIndex] of [
      ['viewer', 0],
      ['opponent', 1],
    ] as const) {
      const labelKey = player === 'viewer' ? 'game.you' : 'game.opponent';
      const outcomeKey =
        winnerSeatIndex === null
          ? 'game.draw'
          : winnerSeatIndex === seatIndex
            ? 'game.win'
            : 'game.loss';
      expect(
        screen.getByText(translate(locale, labelKey), {
          selector: `[data-score-player="${player}"] .score-table-player__label`,
        }),
      ).not.toBeNull();
      expect(
        screen.getByText(translate(locale, outcomeKey), {
          selector: `[data-score-player="${player}"] .score-table-player__heading strong`,
        }),
      ).not.toBeNull();
    }
    if (reasonMessageKey !== null) {
      expect(
        screen.getByText(translate(locale, reasonMessageKey)).getAttribute('data-result-reason'),
      ).toBe(reasonKind);
    } else {
      expect(screen.queryAllByText(/./u, { selector: '[data-result-reason]' })).toHaveLength(0);
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

  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);

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

test('settled final state keeps pending command lifetime without creating receipt-only score feedback', async () => {
  const harness = createHarness();
  const result = deferred<CommandResult>();
  vi.mocked(harness.session.selectScoreCategory).mockReturnValue(result.promise);
  const view = render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: /Twos/u }));
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  act(() => harness.sessions.publish(finishedGame('scoresCompleted', 0)));
  expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
  expect(harness.session.dispose).not.toHaveBeenCalled();
  await act(async () => result.resolve(commandSuccess()));
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  expect(harness.session.dispose).toHaveBeenCalledOnce();
  view.unmount();
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
  act(() => harness.sessions.publish(finishedGame('scoresCompleted', 0)));
  expect(harness.audio.playCue).not.toHaveBeenCalled();
});

test('score rejection produces neither click nor success cue', async () => {
  const harness = createHarness();
  vi.mocked(harness.session.selectScoreCategory).mockResolvedValue({
    ok: false,
    error: { kind: 'server', error: { code: 'STALE_TURN', params: {} } },
  });
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
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
    render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
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

test('score click submits the category without a success cue from a receipt alone', async () => {
  const harness = createHarness();
  const response = deferred<CommandResult>();
  harness.session.selectScoreCategory.mockReturnValue(response.promise);
  render(<GameScreen surfaceExposed={true} {...harness} locale={LOCALE.EN} />);
  fireEvent.click(screen.getByRole('button', { name: /Twos/u }));
  expect(harness.session.selectScoreCategory).toHaveBeenCalledExactlyOnceWith(CATEGORY_ID.TWOS);
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  act(() => harness.sessions.publish({ ...playingGame, stateVersion: 8 }));
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  await act(async () => response.resolve(commandSuccess()));
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  act(() => harness.sessions.publish({ ...playingGame, stateVersion: 8 }));
  expect(harness.audio.playCue).not.toHaveBeenCalled();
});

test.each([
  { cover: 'scoreboard', openBefore: false, returnAt: 1_000 },
  { cover: 'scoreboard', openBefore: false, returnAt: 2_000 },
  { cover: 'scoreboard', openBefore: true, returnAt: 1_000 },
  { cover: 'global', openBefore: false, returnAt: 1_000 },
  { cover: 'global', openBefore: true, returnAt: 1_000 },
])(
  'skips $cover achievement display without shortening its deadline: $openBefore / $returnAt',
  async ({ cover, openBefore, returnAt }) => {
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
        <GameScreen
          surfaceExposed={true}
          {...harness}
          presentation={presentation}
          locale={LOCALE.EN}
        />,
      );
      const setCovered = (covered: boolean) => {
        if (cover === 'global')
          view.rerender(
            <GameScreen
              {...harness}
              presentation={presentation}
              surfaceExposed={!covered}
              locale={LOCALE.EN}
            />,
          );
        else
          fireEvent.click(screen.getByRole('button', { name: covered ? 'Scoreboard' : 'Close' }));
      };
      if (openBefore) setCovered(true);
      await showYacht('scoreboard-yacht');
      if (!openBefore) {
        expect(screen.getByRole('status').getAttribute('data-achievement-kind')).toBe('yacht');
        act(() => {
          vi.advanceTimersByTime(500);
        });
        setCovered(true);
      }
      expect(screen.queryByRole('status')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(returnAt - (openBefore ? 0 : 500));
      });
      setCovered(false);
      expect(screen.queryByRole('status')).toBeNull();
      if (returnAt < 1_980) {
        expect(getPreviewScoreButtons()).toHaveLength(0);
        expect(screen.queryByRole('button', { name: 'Roll again' })).toBeNull();
        // Locale changes and repeated layer visits must not resurrect this roll.
        view.rerender(
          <GameScreen
            surfaceExposed={true}
            {...harness}
            presentation={presentation}
            locale={LOCALE.KO}
          />,
        );
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
      view.rerender(
        <GameScreen
          surfaceExposed={true}
          {...harness}
          presentation={presentation}
          locale={LOCALE.EN}
        />,
      );
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
