// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- stop clock subscriptions before restoring timers. */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useDeadlineReadiness, useDeadlineSeconds } from '@/features/game/hud/game-deadline-hooks';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('samples the server clock without rendering again until the displayed second changes', () => {
  vi.useFakeTimers();
  let serverNow: number | null = 0;
  const clock = { now: () => serverNow };
  const rendered = vi.fn();
  const { result, rerender, unmount } = renderHook(
    ({ deadlineAt }) => {
      const seconds = useDeadlineSeconds(clock, deadlineAt);
      rendered(seconds);
      return seconds;
    },
    { initialProps: { deadlineAt: 2_000 as number | null } },
  );
  expect(result.current).toBe(2);
  rendered.mockClear();

  act(() => {
    serverNow = 750;
    vi.advanceTimersByTime(750);
  });
  expect(rendered).not.toHaveBeenCalled();

  act(() => {
    serverNow = 1_000;
    vi.advanceTimersByTime(250);
  });
  expect(result.current).toBe(1);
  expect(rendered).toHaveBeenCalledOnce();

  act(() => {
    serverNow = 2_500;
    vi.advanceTimersByTime(250);
  });
  expect(result.current).toBe(0);

  rerender({ deadlineAt: 5_000 });
  expect(result.current).toBe(3);
  act(() => {
    serverNow = null;
    vi.advanceTimersByTime(250);
  });
  expect(result.current).toBeNull();
  act(() => {
    serverNow = 4_000;
    vi.advanceTimersByTime(250);
  });
  expect(result.current).toBe(1);

  rerender({ deadlineAt: null });
  expect(result.current).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  unmount();
});

test('updates deadline eligibility only at valid, expired or unknown clock boundaries', () => {
  vi.useFakeTimers();
  let serverNow: number | null = 0;
  const clock = { now: () => serverNow };
  const rendered = vi.fn();
  const { result, rerender, unmount } = renderHook(
    ({ deadlineAt }) => {
      const { ready } = useDeadlineReadiness(clock, deadlineAt);
      rendered(ready);
      return ready;
    },
    { initialProps: { deadlineAt: 6_000 as number | null } },
  );
  expect(result.current).toBe(true);
  rendered.mockClear();
  act(() => {
    serverNow = 5_000;
    vi.advanceTimersByTime(250);
  });
  expect(rendered).not.toHaveBeenCalled();
  act(() => {
    serverNow = 6_000;
    vi.advanceTimersByTime(250);
  });
  expect(result.current).toBe(false);
  expect(rendered).toHaveBeenCalledOnce();
  rerender({ deadlineAt: 8_000 });
  expect(result.current).toBe(true);
  act(() => {
    serverNow = null;
    vi.advanceTimersByTime(250);
  });
  expect(result.current).toBe(false);
  act(() => {
    serverNow = 7_000;
    vi.advanceTimersByTime(250);
  });
  expect(result.current).toBe(true);
  rerender({ deadlineAt: null });
  expect(result.current).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  rerender({ deadlineAt: 9_000 });
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test('keeps the next turn at ninety seconds and opens exactly at its future start', async () => {
  vi.useFakeTimers();
  const clock = { now: () => Date.now() };
  vi.setSystemTime(0);
  const { result, unmount } = renderHook(() => ({
    seconds: useDeadlineSeconds(clock, 91_125, 1_125),
    timing: useDeadlineReadiness(clock, 91_125, 1_125),
  }));
  expect(result.current.seconds).toBe(90);
  expect(result.current.timing.ready).toBe(true);
  expect(result.current.timing.turnReady).toBe(false);
  await act(() => vi.advanceTimersByTime(1_124));
  expect(result.current.seconds).toBe(90);
  expect(result.current.timing.turnReady).toBe(false);
  await act(() => vi.advanceTimersByTime(1));
  expect(result.current.timing.turnReady).toBe(true);
  expect(result.current.seconds).toBe(90);
  await act(() => vi.advanceTimersByTime(90_000));
  expect(result.current.timing.ready).toBe(false);
  expect(result.current.timing.turnReady).toBe(false);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
