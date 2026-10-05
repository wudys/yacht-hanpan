// @vitest-environment jsdom
import { parseGameSnapshot } from '@repo/game-protocol/socket';
import { act, renderHook } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { useTurnFeedback } from '@/features/game/use-turn-feedback';
import { playingGame } from '@/testing/game-fixtures';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function finalOptions() {
  if (playingGame.match.status !== 'playing') throw new Error('Expected playing fixture');
  const game = parseGameSnapshot({
    stateVersion: 8,
    match: {
      status: 'finished',
      players: playingGame.match.players,
      result: { reason: 'scoresCompleted', winnerSeatIndex: 0 },
    },
  });
  return {
    session: {},
    game,
    presentation: {
      kind: 'score',
      record: {
        stateVersion: game.stateVersion,
        completedTurnId: playingGame.match.currentTurn.turnId,
        seatIndex: 0,
        categoryId: 'ones',
        score: 2,
      },
    } as const,
    viewerSeat: 0 as const,
    suspended: false,
    scoreVisible: true,
    boardVisible: true,
    canStartTurn: false,
    rollPending: false,
  };
}

test.each(['normal', 'fractional', 'early'])(
  'final record ends without another render (%s scheduling)',
  async (scheduling) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    if (scheduling === 'early') {
      const schedule = globalThis.setTimeout.bind(globalThis);
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
        schedule(callback, Math.max(1, (delay ?? 0) - 1), ...args),
      );
    }
    if (scheduling === 'fractional') {
      const originalNow = performance.now.bind(performance);
      let reads = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => originalNow() + ++reads * 0.01);
    }
    const options = finalOptions();
    const onRecordStart = vi.fn();
    const onGroupChange = vi.fn();
    const clock = { now: () => 10_000 + performance.now() };
    const { result, rerender, unmount } = renderHook(
      () => useTurnFeedback(options, clock, onRecordStart, onGroupChange),
      { wrapper: StrictMode },
    );
    expect(result.current.record?.final).toBe(true);
    expect(onRecordStart).toHaveBeenCalledTimes(1);
    expect(onGroupChange).toHaveBeenCalledExactlyOnceWith('upper');
    rerender();
    await act(() => vi.advanceTimersByTime(900));
    expect(result.current.record?.phase).toBe('confirming');
    expect(onRecordStart).toHaveBeenCalledTimes(1);
    const remaining = scheduling === 'fractional' ? 102 : 100;
    for (let tick = 0; tick < remaining; tick += 1) await act(() => vi.advanceTimersByTime(1));
    expect(result.current.record).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.each(['unmount', 'suspend'])(
  'cancels an early-callback replacement timer on %s',
  async (cancellation) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const schedule = globalThis.setTimeout.bind(globalThis);
    const timeout = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delay, ...args) =>
        schedule(callback, Math.max(1, (delay ?? 0) - 1), ...args),
      );
    const options = finalOptions();
    const onRecordStart = vi.fn();
    const clock = { now: () => 10_000 + performance.now() };
    const { result, rerender, unmount } = renderHook(
      (input) => useTurnFeedback(input, clock, onRecordStart, vi.fn()),
      { initialProps: options },
    );
    await act(() => vi.advanceTimersByTime(999));
    expect(result.current.record?.final).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(timeout).toHaveBeenCalledTimes(2);
    if (cancellation === 'unmount') unmount();
    else {
      rerender({ ...options, suspended: true });
      expect(result.current.record).toBeNull();
    }
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTime(2000));
    expect(onRecordStart).toHaveBeenCalledTimes(1);
    unmount();
  },
);
