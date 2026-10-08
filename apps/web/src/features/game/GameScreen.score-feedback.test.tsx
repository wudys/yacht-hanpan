// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- external stores and timers are disposed before the next test. */

import { createGameSession, type CreateGameSessionOptions } from '@repo/game-client-sdk/session';
import {
  CATEGORY_ID,
  type GameSnapshotInput,
  parseResolvedRollArtifact,
  parseRoomView,
  type RoomView,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { type CategoryId, type Dice, scoreCategory } from '@repo/yacht-rules';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import GameScreen from '@/features/game/GameScreen';
import { LOCALE, translate } from '@/i18n';
import { startGameAudioFeedback } from '@/runtime/audio/game-audio-feedback';
import { PRODUCT_CUE } from '@/runtime/audio/product-cues';
import { createPreferencesStore } from '@/runtime/preferences/preferences-store';
import { createGameSessionHolder } from '@/runtime/session/game-session-holder';
import {
  authority,
  initialPlayingMatch,
  playingGameInput,
  room,
  waitingRoom,
} from '@/testing/game-fixtures';
import {
  createAudioMock,
  createPresentationFake,
  createRecoveryFake,
  createSessionCredentialStoreSpy,
} from '@/testing/game-harness';

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const disposers = new Set<() => void>();
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      public observe(): void {}
      public disconnect(): void {}
    },
  );
});
afterEach(() => {
  cleanup();
  disposers.forEach((dispose) => dispose());
  disposers.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function roomView(game: GameSnapshotInput): RoomView {
  return parseRoomView({
    room:
      game.match.status === 'finished' ? { ...room, status: 'finished', finishedAt: 10_000 } : room,
    game,
    presence: {
      roomId: authority.roomId,
      presenceVersion: 1,
      seats: [{ status: 'connected' }, { status: 'connected' }],
    },
  });
}

const beforeScore = roomView({
  ...playingGameInput,
  match: {
    ...initialPlayingMatch,
    currentTurn: {
      ...initialPlayingMatch.currentTurn,
      dice: [{ value: 3 }, { value: 3 }, { value: 4 }, { value: 4 }, { value: 6 }],
    },
  },
});

function assertRecordableFixture(before: RoomView, categoryId: CategoryId, expectedScore: number) {
  const match = before.game?.match;
  if (match?.status !== 'playing') throw new Error('A score fixture needs a playing view');
  const { currentTurn } = match;
  // Both fixture helpers record seat 0; viewerSeat only changes the observer.
  if (currentTurn.seatIndex !== 0) throw new Error('A score fixture needs seat 0 to record');
  if (currentTurn.rollCount === 0 || currentTurn.dice === null) {
    throw new Error('A score fixture needs revealed dice after a roll');
  }
  if (match.players[0].scorecard[categoryId] !== undefined) {
    throw new Error(`Score fixture ${categoryId} is already recorded`);
  }
  const dice: Dice = [
    currentTurn.dice[0].value,
    currentTurn.dice[1].value,
    currentTurn.dice[2].value,
    currentTurn.dice[3].value,
    currentTurn.dice[4].value,
  ];
  const actualScore = scoreCategory(categoryId, dice);
  if (actualScore !== expectedScore) {
    throw new Error(
      `Score fixture ${categoryId}: expected ${expectedScore}, actual ${actualScore}`,
    );
  }
  return match;
}

test('a mismatched score fixture fails before publication', () => {
  const publish = vi.fn();
  expect(() => publish(scoreTransition(CATEGORY_ID.TWOS, 1))).toThrow(
    'Score fixture twos: expected 1, actual 0',
  );
  expect(publish).not.toHaveBeenCalled();
});

// This fixture hands seat 0's record to seat 1 at the fixed next-turn times below.
function scoreTransition(
  categoryId: CategoryId = CATEGORY_ID.TWOS,
  expectedScore: number = 0,
  before: RoomView = beforeScore,
): RoomView {
  const match = assertRecordableFixture(before, categoryId, expectedScore);
  const game = before.game!;
  return parseRoomView({
    ...before,
    game: {
      ...game,
      stateVersion: game.stateVersion + 1,
      match: {
        ...match,
        players: [
          {
            ...match.players[0],
            scorecard: { ...match.players[0].scorecard, [categoryId]: expectedScore },
          },
          match.players[1],
        ],
        currentTurn: {
          ...match.currentTurn,
          turnId: '11111111-1111-4111-8111-000000000002',
          seatIndex: 1,
          startedAt: 11_000,
          deadlineAt: 101_000,
          rollCount: 0,
          heldSlots: [],
          dice: null,
        },
      },
    },
  });
}

async function createHarness(
  viewerSeat: 0 | 1 = 0,
  initial: RoomView = beforeScore,
  acknowledgementTimeoutMs: number = 100,
) {
  type Socket = ReturnType<NonNullable<CreateGameSessionOptions['socketFactory']>['create']>;
  const meta = {
    requestId: '11111111-1111-4111-8111-000000000003',
    gameProtocolVersion: GAME_PROTOCOL_VERSION,
    serverTime: 10_000,
  };
  let synchronizationView = initial;
  const socket = {
    connect: vi.fn<Socket['connect']>(async () => {
      socket.onConnected.mock.lastCall?.[0]();
    }),
    disconnect: vi.fn<Socket['disconnect']>(),
    dispose: vi.fn<Socket['dispose']>(),
    emitSync: vi.fn<Socket['emitSync']>((ack) =>
      ack({ ok: true, data: synchronizationView, meta }),
    ),
    emitCommand: vi.fn<Socket['emitCommand']>(),
    onConnected: vi.fn<Socket['onConnected']>(() => () => {}),
    onDisconnected: vi.fn<Socket['onDisconnected']>(() => () => {}),
    onReplaced: vi.fn<Socket['onReplaced']>(() => () => {}),
    onRoomUpdate: vi.fn<Socket['onRoomUpdate']>(() => () => {}),
    onConnectionError: vi.fn<Socket['onConnectionError']>(() => () => {}),
  } satisfies Socket;
  const sessions = createGameSessionHolder({
    createSession: (credentials) =>
      createGameSession({
        authority: credentials,
        contract: createCompatibilityContract('test-release'),
        socketUrl: 'https://game.example.test',
        socketFactory: { create: () => socket },
        retryPolicy: { acknowledgementTimeoutMs, maximumAttempts: 1, retryDelayMs: 0 },
      }),
  });
  const session = sessions.installAuthority({ ...authority, seatIndex: viewerSeat });
  expect(await session.connect()).toEqual({ ok: true });
  const audio = createAudioMock();
  const recovery = createRecoveryFake();
  const preferences = createPreferencesStore({ getItem: () => null, setItem: () => {} });
  preferences.setLocale(LOCALE.EN);
  const clock = { now: () => 10_000 + performance.now() };
  const feedback = startGameAudioFeedback({ audio, sessions, recovery, preferences, clock });
  disposers.add(feedback.dispose);
  disposers.add(sessions.dispose);
  const harness = {
    audio,
    recovery,
    preferences,
    clock,
    feedback,
    sessions,
    session,
    socket,
    presentation: createPresentationFake(),
    sessionCredentialStore: createSessionCredentialStoreSpy(),
    publish(view: RoomView) {
      synchronizationView = view;
      act(() => socket.onRoomUpdate.mock.lastCall?.[0]({ type: 'state:committed', view }));
    },
    async synchronize(view: RoomView) {
      synchronizationView = view;
      await act(async () => {
        await session.synchronize();
      });
    },
    async acknowledge(view: RoomView, receiptVersion: number = view.game!.stateVersion) {
      const [command, acknowledge] = socket.emitCommand.mock.lastCall!;
      await act(async () =>
        acknowledge({
          ok: true,
          data: { receipt: { stateVersion: receiptVersion }, view },
          meta: {
            requestId: meta.requestId,
            gameProtocolVersion: GAME_PROTOCOL_VERSION,
            actionId: command.actionId,
          },
        }),
      );
    },
  };
  return harness;
}

function summary() {
  return screen.getByRole('group', { name: /^Total /u });
}
function expectScorePreviewsHidden() {
  expect(
    screen
      .getAllByRole('button')
      .some((button) => button.getAttribute('data-value-state') === 'preview'),
  ).toBe(false);
  expect(screen.queryAllByText(/^Max \d+$/u)).toHaveLength(0);
}

test.each([0, 1] as const)(
  'a zero-point Yacht uses ordinary record feedback for viewer %s',
  async (viewerSeat) => {
    const harness = await createHarness(viewerSeat);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    harness.publish(scoreTransition(CATEGORY_ID.YACHT, 0));

    const cell = screen.getByRole('button', { name: 'Yacht · 0' });
    expect(cell.getAttribute('data-value-state')).toBe('recorded');
    expect(
      within(cell).queryAllByText(
        (_text, element) => element?.classList.contains('score-feedback__particle') ?? false,
      ).length,
    ).toBeGreaterThan(0);
    expect(
      within(cell).queryByText(
        (_text, element) => element?.getAttribute('data-yacht-ring') === 'recorded',
      ),
    ).toBeNull();
    expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
  },
);

function tab(group: 'upper' | 'lower') {
  return screen
    .getAllByRole('tab', { hidden: true })
    .find((element) => element.getAttribute('data-score-tab') === group)!;
}
function advance(milliseconds: number) {
  act(() => {
    vi.advanceTimersByTime(milliseconds);
  });
}

test.each([0, 1] as const)(
  'both seats retain the recorded owner and 0 before the 900ms handoff (viewer %s)',
  async (viewerSeat) => {
    const harness = await createHarness(viewerSeat);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    harness.publish(scoreTransition());
    const owner = viewerSeat === 0 ? 'viewer' : 'opponent';
    expect(summary().getAttribute('data-player-summary')).toBe(owner);
    expect(summary().getAttribute('aria-label')).toBe('Total 2 · Bonus not earned');
    expect(screen.getByRole('button', { name: /Twos/u }).getAttribute('data-value-state')).toBe(
      'recorded',
    );
    expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
    expectScorePreviewsHidden();
    advance(899);
    expect(summary().getAttribute('data-player-summary')).toBe(owner);
    expectScorePreviewsHidden();
    advance(1);
    expect(summary().getAttribute('data-player-summary')).toBe(
      viewerSeat === 0 ? 'opponent' : 'viewer',
    );
    expect(summary().getAttribute('aria-label')).toBe('Total 1 · Bonus not earned');
    expect(screen.getByRole('button', { name: /Twos/u }).getAttribute('data-value-state')).toBe(
      'empty',
    );
    expectScorePreviewsHidden();
    advance(100);
    expectScorePreviewsHidden();
    harness.publish(scoreTransition());
    expect(harness.audio.playCue).toHaveBeenCalledTimes(1);
  },
);

test('synchronizing newer settled dice cancels confirmation and restores the current player previews', async () => {
  const harness = await createHarness(0);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  harness.publish(scoreTransition());
  advance(300);
  expectScorePreviewsHidden();
  vi.spyOn(harness.clock, 'now').mockReturnValue(12_000);
  await harness.synchronize(
    roomView({
      stateVersion: 9,
      match: {
        ...initialPlayingMatch,
        players: [
          { scorecard: { ones: 2, twos: 0 }, timeoutCount: 0 },
          initialPlayingMatch.players[1],
        ],
        currentTurn: {
          ...initialPlayingMatch.currentTurn,
          turnId: '11111111-1111-4111-8111-000000000002',
          seatIndex: 1,
          startedAt: 11_000,
          deadlineAt: 101_000,
          rollCount: 1,
          heldSlots: [],
          dice: [{ value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }],
        },
      },
    }),
  );

  expect(summary().getAttribute('data-player-summary')).toBe('opponent');
  const twos = screen.getByRole('button', { name: 'Twos · 0' });
  expect(twos.getAttribute('data-value-state')).toBe('preview');
  expect(twos.hasAttribute('disabled')).toBe(true);
  expect(tab('upper').textContent).toBe('UpperMax 30');
  expect(tab('lower').textContent).toBe('LowerMax 50');
  advance(1000);
  expect(screen.getByRole('button', { name: 'Twos · 0' }).getAttribute('data-value-state')).toBe(
    'preview',
  );
  expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
});

test('input waits for 1000ms while YOUR TURN starts at readiness and clears on the first roll request', async () => {
  const harness = await createHarness(1);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  harness.publish(scoreTransition());
  const roll = screen.getByRole('button', { name: 'Roll' });
  advance(999);
  expect(roll.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(roll);
  expect(harness.socket.emitCommand).not.toHaveBeenCalled();
  expect(screen.queryByText('YOUR TURN')).toBeNull();
  advance(1);
  expect(roll.getAttribute('aria-disabled')).toBe('false');
  expect(screen.getByText('YOUR TURN')).not.toBeNull();
  fireEvent.click(roll);
  expect(harness.socket.emitCommand).toHaveBeenCalledOnce();
  expect(screen.queryByText('YOUR TURN')).toBeNull();
});

test.each([false, true])(
  'YOUR TURN expires without another interaction or replay after remount (fractional=%s)',
  async (fractional) => {
    if (fractional) {
      const originalNow = performance.now.bind(performance);
      let reads = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => originalNow() + ++reads * 0.01);
    }
    const harness = await createHarness(1);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    harness.publish(scoreTransition());
    advance(1000);
    expect(screen.getByText('YOUR TURN')).not.toBeNull();
    expect(
      screen.getByText(translate(LOCALE.EN, 'game.turnStartCue'), { selector: '[role="status"]' }),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Roll' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
    advance(649);
    expect(screen.getByText('YOUR TURN')).not.toBeNull();
    expect(
      screen.getByText(translate(LOCALE.EN, 'game.turnStartCue'), { selector: '[role="status"]' }),
    ).not.toBeNull();
    advance(fractional ? 2 : 1);
    expect(screen.queryByText('YOUR TURN')).toBeNull();
    expect(
      screen.queryByText(translate(LOCALE.EN, 'game.turnStartCue'), {
        selector: '[role="status"]',
      }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Scoreboard' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('YOUR TURN')).toBeNull();
    expect(
      screen.queryByText(translate(LOCALE.EN, 'game.turnStartCue'), {
        selector: '[role="status"]',
      }),
    ).toBeNull();
    expect(
      harness.audio.playCue.mock.calls.filter(([cue]) => cue === PRODUCT_CUE.SCORE),
    ).toHaveLength(1);
  },
);

test('a score moves both seats once to its group and preserves later manual selection across duplicate and presence updates', async () => {
  const harness = await createHarness(1);
  const view = render(<GameScreen {...harness} locale={LOCALE.EN} />);
  const recorded = scoreTransition(CATEGORY_ID.CHOICE, 20);
  harness.publish(recorded);
  expect(tab('lower').getAttribute('aria-selected')).toBe('true');
  fireEvent.click(tab('upper'));
  advance(300);
  harness.publish(
    parseRoomView({ ...recorded, presence: { ...recorded.presence!, presenceVersion: 2 } }),
  );
  view.rerender(<GameScreen {...harness} locale={LOCALE.KO} />);
  advance(700);
  expect(tab('upper').getAttribute('aria-selected')).toBe('true');
  expect(
    harness.audio.playCue.mock.calls.filter(([cue]) => cue === PRODUCT_CUE.SCORE),
  ).toHaveLength(1);
});

test.each([
  [0, 'upper', 'lower', CATEGORY_ID.CHOICE],
  [1, 'upper', 'lower', CATEGORY_ID.CHOICE],
  [0, 'lower', 'upper', CATEGORY_ID.TWOS],
  [1, 'lower', 'upper', CATEGORY_ID.TWOS],
] as const)(
  'viewer %s returns from the temporary %s-to-%s score tab with the incoming owner',
  async (viewerSeat, previousGroup, recordedGroup, category) => {
    const harness = await createHarness(viewerSeat);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    fireEvent.click(tab(previousGroup));
    harness.audio.playCue.mockClear();
    harness.publish(scoreTransition(category, category === CATEGORY_ID.CHOICE ? 20 : 0));
    expect(tab(recordedGroup).getAttribute('aria-selected')).toBe('true');
    advance(899);
    expect(tab(recordedGroup).getAttribute('aria-selected')).toBe('true');
    expect(summary().getAttribute('data-player-summary')).toBe(
      viewerSeat === 0 ? 'viewer' : 'opponent',
    );
    advance(1);
    expect(tab(previousGroup).getAttribute('aria-selected')).toBe('true');
    expect(summary().getAttribute('data-player-summary')).toBe(
      viewerSeat === 0 ? 'opponent' : 'viewer',
    );
    advance(100);
    expect(tab(previousGroup).getAttribute('aria-selected')).toBe('true');
    expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
  },
);

test('reselecting the automatically displayed tab keeps that choice without another select sound', async () => {
  const harness = await createHarness(1);
  const view = render(<GameScreen {...harness} locale={LOCALE.EN} />);
  const recorded = scoreTransition(CATEGORY_ID.CHOICE, 20);
  harness.publish(recorded);
  fireEvent.click(tab('lower'));
  advance(1000);
  harness.publish(recorded);
  view.rerender(<GameScreen {...harness} locale={LOCALE.KO} />);
  expect(tab('lower').getAttribute('aria-selected')).toBe('true');
  expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
});

function finalViews() {
  const scores: Record<string, number> = {
    ...Object.fromEntries(Object.values(CATEGORY_ID).map((category) => [category, 0])),
    choice: 5,
  };
  const beforeScores = { ...scores };
  delete beforeScores.yacht;
  const playing = roomView({
    ...playingGameInput,
    match: {
      ...initialPlayingMatch,
      players: [
        { scorecard: beforeScores, timeoutCount: 0 },
        { scorecard: scores, timeoutCount: 0 },
      ],
      currentTurn: {
        ...initialPlayingMatch.currentTurn,
        heldSlots: [],
        dice: [{ value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }],
      },
    },
  });
  assertRecordableFixture(playing, CATEGORY_ID.YACHT, 50);
  const finished = roomView({
    stateVersion: 8,
    match: {
      status: 'finished',
      players: [
        { scorecard: { ...scores, yacht: 50 }, timeoutCount: 0 },
        { scorecard: scores, timeoutCount: 0 },
      ],
      result: { reason: 'scoresCompleted', winnerSeatIndex: 0 },
    },
  });
  return { playing, finished };
}

test.each(['ack-first', 'live-first'] as const)(
  'final score never flashes Result and cleanup follows command lifetime independently of its 1000ms display (%s)',
  async (order) => {
    const { playing, finished } = finalViews();
    const harness = await createHarness(0, playing);
    const resultCommits = vi.fn();
    render(
      <Profiler
        id='game'
        onRender={() => {
          if (screen.queryByRole('heading', { name: 'Game result' }) !== null) resultCommits();
        }}
      >
        <GameScreen {...harness} locale={LOCALE.EN} />
      </Profiler>,
    );
    fireEvent.click(tab('lower'));
    harness.audio.playCue.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Yacht/u }));
    expect(harness.audio.playCue).not.toHaveBeenCalled();
    if (order === 'ack-first') {
      await harness.acknowledge(finished);
    } else {
      harness.publish(finished);
    }
    expect(screen.queryByRole('heading', { name: 'Game result' })).toBeNull();
    expect(summary().getAttribute('aria-label')).toBe('Total 55 · Bonus not earned');
    expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
    expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
    expect(harness.audio.setScene).toHaveBeenLastCalledWith('game');
    expect(resultCommits).not.toHaveBeenCalled();
    if (order !== 'ack-first') {
      expect(harness.session.getSnapshot().connection).toBe('connected');
      await harness.acknowledge(finished);
    }
    expect(harness.session.getSnapshot().connection).toBe('disposed');
    expect(screen.queryByRole('heading', { name: 'Game result' })).toBeNull();
    advance(999);
    expect(screen.queryByRole('heading', { name: 'Game result' })).toBeNull();
    expect(resultCommits).not.toHaveBeenCalled();
    expect(harness.audio.setScene).not.toHaveBeenCalledWith('result');
    advance(1);
    expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
    expect(resultCommits).toHaveBeenCalled();
    expect(harness.audio.setScene).toHaveBeenLastCalledWith('result');
    expect(harness.audio.playCue).toHaveBeenCalledTimes(1);
    expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
  },
);

test('a live final score shows Result at 1000ms while its original command remains pending until the 1500ms ACK', async () => {
  const { playing, finished } = finalViews();
  const harness = await createHarness(0, playing, 5000);
  const selectScore = vi.spyOn(harness.session, 'selectScoreCategory');
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  fireEvent.click(tab('lower'));
  harness.audio.playCue.mockClear();
  fireEvent.click(screen.getByRole('button', { name: /Yacht/u }));
  const commandFinished = vi.fn();
  void selectScore.mock.results[0]!.value.then(commandFinished);
  harness.publish(finished);
  expect(summary().getAttribute('aria-label')).toBe('Total 55 · Bonus not earned');
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
  advance(999);
  expect(screen.queryByRole('heading', { name: 'Game result' })).toBeNull();
  advance(1);
  const result = screen.getByRole('heading', { name: 'Game result' });
  expect(harness.session.getSnapshot().connection).toBe('connected');
  expect(commandFinished).not.toHaveBeenCalled();
  expect(harness.audio.setScene).toHaveBeenLastCalledWith('result');
  advance(500);
  expect(harness.session.getSnapshot().connection).toBe('connected');
  expect(commandFinished).not.toHaveBeenCalled();
  await harness.acknowledge(finished);
  await expect(selectScore.mock.results[0]?.value).resolves.toMatchObject({
    ok: true,
    data: { stateVersion: 8 },
  });
  expect(harness.session.getSnapshot().connection).toBe('disposed');
  expect(commandFinished).toHaveBeenCalledOnce();
  expect(screen.getByRole('heading', { name: 'Game result' })).toBe(result);
  advance(1000);
  expect(screen.getByRole('heading', { name: 'Game result' })).toBe(result);
  expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
});

test.each(['explicitForfeit', 'connectionEnded'] as const)(
  '%s at 300ms cancels record confirmation immediately without later feedback or a turn cue',
  async (reason) => {
    const harness = await createHarness(1);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    const recorded = scoreTransition();
    harness.publish(recorded);
    advance(300);
    expect(screen.queryByRole('heading', { name: 'Game result' })).toBeNull();
    harness.publish(
      roomView({
        stateVersion: 9,
        match: {
          status: 'finished',
          players: [...recorded.game!.match.players],
          result: { reason, winnerSeatIndex: 1 },
        },
      }),
    );
    const result = screen.getByRole('heading', { name: 'Game result' });
    expect(harness.session.getSnapshot().connection).toBe('disposed');
    expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
    expect(screen.queryByText('YOUR TURN')).toBeNull();
    advance(2000);
    expect(screen.getByRole('heading', { name: 'Game result' })).toBe(result);
    expect(screen.queryByText('YOUR TURN')).toBeNull();
    expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
    expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
  },
);

test('a final score known only through synchronization displays Result immediately without success feedback', async () => {
  const { playing, finished } = finalViews();
  const harness = await createHarness(0, playing);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  await harness.synchronize(finished);
  expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  expect(harness.session.getSnapshot().connection).toBe('disposed');
});

test('the final automatic record tab stays visible past 900ms until Result replaces the board', async () => {
  const { playing, finished } = finalViews();
  const harness = await createHarness(1, playing);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  expect(tab('upper').getAttribute('aria-selected')).toBe('true');
  harness.publish(finished);
  expect(tab('lower').getAttribute('aria-selected')).toBe('true');
  advance(900);
  expect(tab('lower').getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('heading', { name: 'Game result' })).toBeNull();
  advance(100);
  expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
});

test.each(['hidden', 'recovery', 'restore'] as const)(
  'cancelling a visible confirmation through %s restores the previous tab without replay',
  async (cancellation) => {
    const harness = await createHarness(1);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    const recorded = scoreTransition(CATEGORY_ID.CHOICE, 20);
    harness.publish(recorded);
    expect(tab('lower').getAttribute('aria-selected')).toBe('true');
    advance(300);
    if (cancellation === 'restore') await harness.synchronize(recorded);
    else {
      act(() => {
        if (cancellation === 'hidden') {
          visibility.mockReturnValue('hidden');
          document.dispatchEvent(new Event('visibilitychange'));
        } else harness.recovery.publish({ status: 'synchronizing' });
      });
      act(() => {
        visibility.mockReturnValue('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        harness.recovery.publish({ status: 'idle' });
      });
    }
    expect(tab('upper').getAttribute('aria-selected')).toBe('true');
    harness.publish(recorded);
    advance(1000);
    expect(tab('upper').getAttribute('aria-selected')).toBe('true');
    expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
  },
);

test.each(['hidden', 'recovery'] as const)(
  'a record accepted during %s does not replay after returning',
  async (suspension) => {
    const harness = await createHarness(1);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    act(() => {
      if (suspension === 'hidden') {
        visibility.mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      } else harness.recovery.publish({ status: 'synchronizing' });
    });
    harness.publish(scoreTransition(CATEGORY_ID.CHOICE, 20));
    act(() => {
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      harness.recovery.publish({ status: 'idle' });
    });
    expect(summary().getAttribute('data-player-summary')).toBe('viewer');
    expect(tab('upper').getAttribute('aria-selected')).toBe('true');
    expect(harness.audio.playCue).not.toHaveBeenCalled();
    advance(1000);
    expect(screen.queryByText('YOUR TURN')).toBeNull();
    expect(harness.audio.playCue).not.toHaveBeenCalled();
  },
);

test.each(['settings', 'scoreboard'] as const)(
  'keeps the %s layer and skips hidden feedback after closing it',
  async (layer) => {
    const harness = await createHarness(1);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    fireEvent.click(
      screen.getByRole('button', { name: layer === 'settings' ? 'Settings' : 'Scoreboard' }),
    );
    const heading = screen.getByRole('heading', {
      name: layer === 'settings' ? 'Settings' : 'Scoreboard',
    });
    harness.audio.playCue.mockClear();
    harness.publish(scoreTransition(CATEGORY_ID.CHOICE, 20));
    expect(
      screen.getByRole('heading', { name: layer === 'settings' ? 'Settings' : 'Scoreboard' }),
    ).toBe(heading);
    expect(harness.audio.playCue).not.toHaveBeenCalled();
    if (layer === 'scoreboard') {
      const choice = screen.getByRole('row', { name: /Choice/u });
      expect(within(choice).getByText('20')).not.toBeNull();
    }
    advance(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(tab('lower').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('YOUR TURN')).toBeNull();
    expect(
      harness.audio.playCue.mock.calls.filter(([cue]) => cue === PRODUCT_CUE.SCORE),
    ).toHaveLength(0);
  },
);

test.each(['settings', 'scoreboard'] as const)(
  'opening %s during a visible confirmation discards its temporary tab without reinterpreting it',
  async (layer) => {
    const harness = await createHarness(1);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    const recorded = scoreTransition(CATEGORY_ID.CHOICE, 20);
    harness.publish(recorded);
    expect(tab('lower').getAttribute('aria-selected')).toBe('true');
    advance(300);
    fireEvent.click(
      screen.getByRole('button', { name: layer === 'settings' ? 'Settings' : 'Scoreboard' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(tab('upper').getAttribute('aria-selected')).toBe('true');
    harness.publish(recorded);
    advance(1000);
    expect(tab('upper').getAttribute('aria-selected')).toBe('true');
    expect(
      harness.audio.playCue.mock.calls.filter(([cue]) => cue === PRODUCT_CUE.SCORE),
    ).toHaveLength(1);
  },
);

test('the open bonus popover follows the same summary owner at the 900ms handoff', async () => {
  const before = roomView({
    ...playingGameInput,
    match: {
      ...initialPlayingMatch,
      currentTurn: {
        ...initialPlayingMatch.currentTurn,
        dice: [{ value: 2 }, { value: 2 }, { value: 2 }, { value: 6 }, { value: 6 }],
      },
    },
  });
  const harness = await createHarness(0, before);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  fireEvent.click(tab('lower'));
  fireEvent.click(screen.getByRole('button', { name: 'Bonus rule' }));
  const popover = screen.getByRole('dialog', { name: 'Bonus rule' });
  harness.audio.playCue.mockClear();
  harness.publish(scoreTransition(CATEGORY_ID.TWOS, 6, before));
  expect(tab('upper').getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('dialog', { name: 'Bonus rule' })).toBe(popover);
  expect(within(popover).getByText('8/63')).not.toBeNull();
  fireEvent.click(tab('upper'));
  advance(900);
  expect(tab('lower').getAttribute('aria-selected')).toBe('true');
  expect(screen.getByRole('dialog', { name: 'Bonus rule' })).toBe(popover);
  expect(within(popover).getByText('1/63')).not.toBeNull();
  expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
});

test('a live final score sounds once, then ACK timeout recovery cancels confirmation and displays Result immediately', async () => {
  const { playing, finished } = finalViews();
  const harness = await createHarness(0, playing);
  const score = vi.spyOn(harness.session, 'selectScoreCategory');
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  fireEvent.click(tab('lower'));
  harness.audio.playCue.mockClear();
  fireEvent.click(screen.getByRole('button', { name: /Yacht/u }));
  harness.publish(finished);
  expect(screen.queryByRole('heading', { name: 'Game result' })).toBeNull();
  expect(harness.audio.playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.SCORE);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  await expect(score.mock.results[0]?.value).resolves.toMatchObject({
    ok: false,
    error: { code: 'ACK_TIMEOUT' },
  });
  expect(screen.getByRole('heading', { name: 'Game result' })).not.toBeNull();
  expect(harness.session.getSnapshot().connection).toBe('disposed');
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
  advance(1000);
  expect(harness.audio.playCue).toHaveBeenCalledTimes(1);
});

test.each([1000, 1100])(
  'a record arriving at %ims projects current state without a new confirmation or temporary tab',
  async (arrivalAt) => {
    const harness = await createHarness(1);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    advance(arrivalAt);
    const recorded = scoreTransition(CATEGORY_ID.CHOICE, 20);
    harness.publish(recorded);
    expect(summary().getAttribute('data-player-summary')).toBe('viewer');
    expect(tab('lower').getAttribute('aria-selected')).toBe('true');
    expect(harness.audio.playCue).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Roll' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
    expect(screen.queryByText('YOUR TURN')).toBeNull();
    advance(1000);
    harness.publish(recorded);
    expect(tab('lower').getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText('YOUR TURN')).toBeNull();
    fireEvent.click(tab('upper'));
    harness.publish(recorded);
    expect(tab('upper').getAttribute('aria-selected')).toBe('true');
    expect(
      harness.audio.playCue.mock.calls.filter(([cue]) => cue === PRODUCT_CUE.SCORE),
    ).toHaveLength(0);
  },
);

test('SFX off consumes a fresh record so turning sound on does not replay it', async () => {
  const harness = await createHarness();
  harness.preferences.setSfxEnabled(false);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  harness.publish(scoreTransition());
  expect(summary().getAttribute('aria-label')).toBe('Total 2 · Bonus not earned');
  expect(harness.audio.playCue).not.toHaveBeenCalled();
  act(() => harness.preferences.setSfxEnabled(true));
  harness.publish(scoreTransition());
  expect(harness.audio.playCue).not.toHaveBeenCalled();
});

function yachtGame(recorded: undefined | 0 | 50 = undefined): GameSnapshotInput {
  return {
    ...playingGameInput,
    match: {
      ...initialPlayingMatch,
      players: [
        {
          scorecard: recorded === undefined ? { ones: 2 } : { ones: 2, yacht: recorded },
          timeoutCount: 0,
        },
        initialPlayingMatch.players[1],
      ],
      currentTurn: {
        ...initialPlayingMatch.currentTurn,
        heldSlots: [],
        dice: [{ value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }],
      },
    },
  };
}

function yachtRing() {
  return within(screen.getByRole('button', { name: /Yacht/u })).queryByText(
    (_text, element) => element?.getAttribute('data-yacht-ring') === 'available',
  );
}

test.each([0, 1] as const)(
  'freshly revealed unrecorded Yacht moves viewer %s once while its ring does not unlock achievement input',
  async (viewerSeat) => {
    const initial = yachtGame();
    const harness = await createHarness(viewerSeat, roomView(initial));
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    const rolled = roomView({
      ...initial,
      stateVersion: 8,
      match: {
        ...initialPlayingMatch,
        currentTurn: {
          ...initialPlayingMatch.currentTurn,
          heldSlots: [],
          rollCount: 2,
          dice: [{ value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }],
        },
      },
    });
    const roll = parseResolvedRollArtifact({
      type: 'roll:resolved',
      replay: {
        mode: 'seeded-physics',
        rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
        seed: 'yacht-ring-test',
        pourStyle: 'classic',
        rolledSlots: [0, 1, 2, 3, 4],
        contract: createCompatibilityContract('test-release'),
      },
      outcome: { authoritativeValuesBySlot: [0, 1, 2, 3, 4].map((slot) => ({ slot, value: 6 })) },
    });
    act(() => {
      harness.presentation.publish({ phase: 'hidden', resources: null });
      harness.socket.onRoomUpdate.mock.lastCall?.[0]({
        type: 'roll:committed',
        view: rolled,
        roll,
      });
    });
    expect(tab('upper').getAttribute('aria-selected')).toBe('true');
    act(() =>
      harness.presentation.publish({
        phase: 'achievement',
        resources: null,
        dice: [],
        rollId: roll.replay.rollId,
        achievement: { kind: 'yacht', categoryId: 'yacht' },
      }),
    );
    expect(tab('lower').getAttribute('aria-selected')).toBe('true');
    expect(yachtRing()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Yacht/u }));
    expect(harness.socket.emitCommand).not.toHaveBeenCalled();
    fireEvent.click(tab('upper'));
    const beforeRecord = parseRoomView({
      ...rolled,
      presence: { ...rolled.presence, presenceVersion: 2 },
    });
    harness.publish(beforeRecord);
    act(() => harness.presentation.publish({ phase: 'settled', resources: null, dice: [] }));
    expect(tab('upper').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tab('lower'));
    expect(yachtRing()).not.toBeNull();
    harness.publish(scoreTransition(CATEGORY_ID.CHOICE, 30, beforeRecord));
    expect(yachtRing()).toBeNull();
  },
);

test.each([undefined, 0, 50] as const)(
  'restored Yacht %s only restores an eligible ring and never auto-selects its tab',
  async (recorded) => {
    const harness = await createHarness(1, roomView(yachtGame(recorded)));
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    expect(tab('upper').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(tab('lower'));
    if (recorded === undefined) expect(yachtRing()).not.toBeNull();
    else expect(yachtRing()).toBeNull();
    expect(
      harness.audio.playCue.mock.calls.filter(([cue]) => cue === PRODUCT_CUE.ACHIEVEMENT_YACHT),
    ).toHaveLength(0);
  },
);

test.each([0, 1] as const)(
  'first upper bonus confirmation keeps record total, achievement and gain coherent for viewer %s',
  async (viewerSeat) => {
    const before = {
      ...playingGameInput,
      match: {
        ...initialPlayingMatch,
        players: [
          { scorecard: { twos: 6, threes: 12, fours: 16, fives: 10, sixes: 18 }, timeoutCount: 0 },
          initialPlayingMatch.players[1],
        ],
        currentTurn: {
          ...initialPlayingMatch.currentTurn,
          dice: [{ value: 1 }, { value: 3 }, { value: 4 }, { value: 5 }, { value: 6 }],
        },
      },
    } satisfies GameSnapshotInput;
    const beforeView = roomView(before);
    const harness = await createHarness(viewerSeat, beforeView);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    harness.publish(scoreTransition(CATEGORY_ID.ONES, 1, beforeView));
    expect(summary().getAttribute('aria-label')).toBe('Total 98 · Bonus earned');
    expect(screen.getByText('+35')).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Bonus rule', description: 'Bonus earned' }),
    ).not.toBeNull();
    advance(900);
    expect(summary().getAttribute('aria-label')).toBe('Total 1 · Bonus not earned');
    expect(screen.queryByText('+35')).toBeNull();
  },
);

test.each([0, 1] as const)(
  'a fresh timeout turn shows YOUR TURN only to its newly ready owner (viewer %s)',
  async (viewerSeat) => {
    const harness = await createHarness(viewerSeat);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    harness.publish(
      roomView({
        ...playingGameInput,
        stateVersion: 8,
        match: {
          ...initialPlayingMatch,
          players: [
            { ...initialPlayingMatch.players[0], timeoutCount: 1 },
            initialPlayingMatch.players[1],
          ],
          currentTurn: {
            ...initialPlayingMatch.currentTurn,
            turnId: '11111111-1111-4111-8111-000000000002',
            seatIndex: 1,
            startedAt: 10_000,
            deadlineAt: 100_000,
            rollCount: 0,
            heldSlots: [],
            dice: null,
          },
        },
      }),
    );
    if (viewerSeat === 1) {
      expect(screen.getByText('YOUR TURN')).not.toBeNull();
      expect(screen.getByRole('button', { name: 'Roll' }).getAttribute('aria-disabled')).toBe(
        'false',
      );
    } else expect(screen.queryByText('YOUR TURN')).toBeNull();
    expect(harness.audio.playCue).not.toHaveBeenCalled();
  },
);

test('a live initial turn starts YOUR TURN once while a synchronized initial game does not', async () => {
  const initial = parseRoomView({
    room: waitingRoom,
    game: null,
    presence: {
      roomId: authority.roomId,
      presenceVersion: 1,
      seats: [{ status: 'connected' }],
    },
  });
  const harness = await createHarness(0, initial);
  render(<GameScreen {...harness} locale={LOCALE.EN} />);
  const firstTurn = roomView({
    stateVersion: 1,
    match: {
      ...initialPlayingMatch,
      players: [
        { scorecard: {}, timeoutCount: 0 },
        { scorecard: {}, timeoutCount: 0 },
      ],
      currentTurn: {
        ...initialPlayingMatch.currentTurn,
        startedAt: 10_000,
        deadlineAt: 100_000,
        rollCount: 0,
        heldSlots: [],
        dice: null,
      },
    },
  });
  harness.publish(firstTurn);
  expect(screen.getByText('YOUR TURN')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Roll' }).getAttribute('aria-disabled')).toBe('false');
  advance(650);
  expect(screen.queryByText('YOUR TURN')).toBeNull();
  await harness.synchronize(firstTurn);
  expect(screen.queryByText('YOUR TURN')).toBeNull();
});

test.each(['ready', 'expired'] as const)(
  'a late original score ACK releases its command while the next own turn is %s',
  async (readiness) => {
    const originalTurn = {
      ...playingGameInput,
      match: {
        ...initialPlayingMatch,
        currentTurn: {
          ...initialPlayingMatch.currentTurn,
          dice: [{ value: 1 }, { value: 3 }, { value: 4 }, { value: 5 }, { value: 6 }],
        },
      },
    } satisfies GameSnapshotInput;
    const originalView = roomView(originalTurn);
    const harness = await createHarness(0, originalView, 120_000);
    const selectScore = vi.spyOn(harness.session, 'selectScoreCategory');
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    fireEvent.click(screen.getByRole('button', { name: /Twos/u }));
    expect(harness.socket.emitCommand).toHaveBeenCalledOnce();
    const ownRecord = scoreTransition(CATEGORY_ID.TWOS, 0, originalView);
    harness.publish(ownRecord);
    expect(harness.session.getSnapshot().presentation?.kind).toBe('score');
    advance(1010);

    const opponentRoll = roomView({
      stateVersion: 9,
      match: {
        ...initialPlayingMatch,
        players: [
          { scorecard: { ones: 2, twos: 0 }, timeoutCount: 0 },
          initialPlayingMatch.players[1],
        ],
        currentTurn: {
          ...initialPlayingMatch.currentTurn,
          turnId: '11111111-1111-4111-8111-000000000002',
          seatIndex: 1,
          startedAt: 11_000,
          deadlineAt: 101_000,
          rollCount: 1,
          heldSlots: [],
          dice: [{ value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }],
        },
      },
    });
    const roll = parseResolvedRollArtifact({
      type: 'roll:resolved',
      replay: {
        mode: 'seeded-physics',
        rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96404',
        seed: 'pending-score-next-turn',
        pourStyle: 'classic',
        rolledSlots: [0, 1, 2, 3, 4],
        contract: createCompatibilityContract('test-release'),
      },
      outcome: {
        authoritativeValuesBySlot: [0, 1, 2, 3, 4].map((slot) => ({ slot, value: 1 })),
      },
    });
    act(() =>
      harness.socket.onRoomUpdate.mock.lastCall?.[0]({
        type: 'roll:committed',
        view: opponentRoll,
        roll,
      }),
    );
    expect(harness.session.getSnapshot().presentation?.kind).toBe('roll');
    advance(10);
    const nextOwnTurn = roomView({
      stateVersion: 10,
      match: {
        ...initialPlayingMatch,
        players: [
          { scorecard: { ones: 2, twos: 0 }, timeoutCount: 0 },
          { scorecard: { ones: 1, twos: 0 }, timeoutCount: 0 },
        ],
        currentTurn: {
          ...initialPlayingMatch.currentTurn,
          turnId: '11111111-1111-4111-8111-000000000003',
          seatIndex: 0,
          startedAt: 12_020,
          deadlineAt: 102_020,
          rollCount: 0,
          heldSlots: [],
          dice: null,
        },
      },
    });
    harness.publish(nextOwnTurn);
    expect(harness.session.getSnapshot().presentation).toMatchObject({
      kind: 'score',
      record: { stateVersion: 10, seatIndex: 1, categoryId: CATEGORY_ID.TWOS, score: 0 },
    });
    advance(1000);
    expect(screen.getByRole('button', { name: 'Roll' }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByText('YOUR TURN')).toBeNull();
    if (readiness === 'expired') advance(102_020 - harness.clock.now());
    await harness.acknowledge(nextOwnTurn, 8);
    await expect(selectScore.mock.results[0]?.value).resolves.toMatchObject({
      ok: true,
      data: { stateVersion: 8 },
    });
    expect(harness.session.getSnapshot().game?.stateVersion).toBe(10);
    const rollButton = screen.getByRole('button', { name: 'Roll' });
    if (readiness === 'ready') {
      expect(rollButton.getAttribute('aria-disabled')).toBe('false');
      expect(screen.getByText('YOUR TURN')).not.toBeNull();
      advance(649);
      expect(screen.getByText('YOUR TURN')).not.toBeNull();
      advance(1);
      expect(screen.queryByText('YOUR TURN')).toBeNull();
    } else {
      expect(harness.clock.now()).toBe(102_020);
      expect(rollButton.getAttribute('aria-disabled')).toBe('true');
      expect(screen.queryByText('YOUR TURN')).toBeNull();
      fireEvent.click(rollButton);
      advance(1000);
      expect(rollButton.getAttribute('aria-disabled')).toBe('true');
      expect(screen.queryByText('YOUR TURN')).toBeNull();
      fireEvent.click(rollButton);
      expect(harness.socket.emitCommand).toHaveBeenCalledOnce();
    }
    expect(
      harness.audio.playCue.mock.calls.filter(([cue]) => cue === PRODUCT_CUE.SCORE),
    ).toHaveLength(2);
  },
);

// Account for sub-millisecond render/effect work between reading and scheduling a boundary.
test.each([0, 300, 900])(
  'roll opens without another interaction after a record delayed by %ims',
  async (delay) => {
    const originalNow = performance.now.bind(performance);
    let reads = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => originalNow() + ++reads * 0.01);
    const harness = await createHarness(1);
    render(<GameScreen {...harness} locale={LOCALE.EN} />);
    advance(delay);
    harness.publish(scoreTransition());
    // Commit each timer independently, as the browser does, instead of batching two seconds.
    for (let tick = 0; tick < 1100; tick += 1) advance(1);
    const roll = screen.getByRole('button', { name: 'Roll' });
    expect(roll.getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(roll);
    expect(harness.socket.emitCommand).toHaveBeenCalledOnce();
    expect(harness.socket.emitCommand.mock.lastCall?.[0].type).toBe('rollDice');
  },
);
