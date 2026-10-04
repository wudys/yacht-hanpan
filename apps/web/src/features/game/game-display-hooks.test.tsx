// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- stop clock subscriptions before restoring timers. */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useDelayedRollSpinner } from '@/features/game/game-display-hooks';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('resets the delayed spinner on pending completion, session replacement and unmount', () => {
  vi.useFakeTimers();
  const first = {};
  const second = {};
  const { result, rerender, unmount } = renderHook(
    ({ pending, identity }) => useDelayedRollSpinner(pending, identity),
    { initialProps: { pending: true, identity: first as object | null } },
  );
  act(() => {
    vi.advanceTimersByTime(599);
  });
  expect(result.current).toBe(false);
  rerender({ pending: true, identity: second });
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(result.current).toBe(false);
  act(() => {
    vi.advanceTimersByTime(599);
  });
  expect(result.current).toBe(true);
  rerender({ pending: false, identity: second });
  expect(result.current).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  rerender({ pending: true, identity: second });
  rerender({ pending: true, identity: null });
  expect(result.current).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  rerender({ pending: true, identity: first });
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
