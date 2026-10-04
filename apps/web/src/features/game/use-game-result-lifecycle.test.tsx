// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- hook subscriptions must stop between tests. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { useGameResultLifecycle } from '@/features/game/use-game-result-lifecycle';
import { createBrowserSessionStore } from '@/runtime/session/browser-session-store';
import { authority, finishedGame } from '@/testing/game-fixtures';
import { createGameSessionHarness, createSession, createStore } from '@/testing/game-harness';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
afterEach(() => {
  cleanup();
  navigate.mockReset();
});

function setup(
  store: ReturnType<typeof createStore> = createStore(),
  commandPending: boolean = false,
) {
  const harness = createGameSessionHarness(finishedGame('explicitForfeit', 1));
  const onIntent = vi.fn();
  const { result, rerender } = renderHook(
    ({ commandPending }) => {
      const snapshot = useSyncExternalStore(
        harness.sessions.subscribe,
        harness.sessions.getSnapshot,
      );
      return useGameResultLifecycle(harness.sessions, store, snapshot, onIntent, commandPending);
    },
    { initialProps: { commandPending } },
  );
  return { ...harness, store, result, rerender };
}

test('removes the finished credential once and deduplicates Result return', () => {
  const harness = setup();
  expect(harness.store.removeRoom).toHaveBeenCalledOnce();
  act(() => {
    harness.result.current();
    harness.result.current();
  });
  expect(harness.store.removeRoom).toHaveBeenCalledOnce();
  expect(harness.sessions.clear).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/lobby' });
});

test('removes finished credentials immediately and detaches after the pending command settles', () => {
  const harness = setup(createStore(), true);
  expect(harness.store.removeRoom).toHaveBeenCalledOnce();
  expect(harness.session.dispose).not.toHaveBeenCalled();
  harness.rerender({ commandPending: true });
  expect(harness.session.dispose).not.toHaveBeenCalled();
  harness.rerender({ commandPending: false });
  expect(harness.session.dispose).toHaveBeenCalledOnce();
  expect(harness.store.removeRoom).toHaveBeenCalledOnce();
});

test('Result return clears immediately while a command is pending', () => {
  const harness = setup(createStore(), true);
  act(() => harness.result.current());
  expect(harness.sessions.clear).toHaveBeenCalledOnce();
  expect(harness.store.removeRoom).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/lobby' });
});

test('returns to Lobby even when the real browser storage cannot remove the credential', () => {
  const removeItem = vi.fn(() => {
    throw new Error('storage denied');
  });
  const actual = createBrowserSessionStore({
    storage: { getItem: () => null, setItem() {}, removeItem },
  });
  actual.recordRoom(authority);
  const store = { ...createStore(), removeRoom: vi.fn(actual.removeRoom) };
  const harness = setup(store);
  expect(removeItem).toHaveBeenCalledOnce();
  expect(actual.initialize().recentRoom).toEqual({ status: 'ready', room: null });
  act(() => harness.result.current());
  expect(harness.sessions.clear).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith({ to: '/lobby' });
});

test('detaches a replacement finished session independently of the previous Result', async () => {
  const harness = setup();
  await waitFor(() => expect(harness.session.dispose).toHaveBeenCalledOnce());
  const replacement = createSession({
    ...harness.session.getSnapshot(),
    game: finishedGame('connectionEnded', 0),
  });
  act(() => harness.sessions.replaceSession(replacement));
  await waitFor(() => expect(replacement.dispose).toHaveBeenCalledOnce());
  expect(harness.sessions.detachFinishedSession).toHaveBeenCalledTimes(2);
  expect(harness.sessions.clear).not.toHaveBeenCalled();
});
