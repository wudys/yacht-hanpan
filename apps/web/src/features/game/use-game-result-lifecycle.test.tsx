// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- hook subscriptions must stop between tests. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { useGameResultLifecycle } from '@/features/game/use-game-result-lifecycle';
import { createSessionCredentialStore } from '@/runtime/session/session-credential-store';
import { authority, finishedGame } from '@/testing/game-fixtures';
import {
  createGameSessionHarness,
  createSessionCredentialStoreSpy,
  createSessionMock,
} from '@/testing/game-harness';

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
afterEach(() => {
  cleanup();
  navigate.mockReset();
});

function setup(
  sessionCredentialStore: ReturnType<
    typeof createSessionCredentialStoreSpy
  > = createSessionCredentialStoreSpy(),
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
      return useGameResultLifecycle(
        harness.sessions,
        sessionCredentialStore,
        snapshot,
        onIntent,
        commandPending,
      );
    },
    { initialProps: { commandPending } },
  );
  return { ...harness, sessionCredentialStore, result, rerender };
}

test('removes the finished credential once and deduplicates Result return', () => {
  const harness = setup();
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
  act(() => {
    harness.result.current();
    harness.result.current();
  });
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
  expect(harness.sessions.clear).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/lobby' });
});

test('removes finished credentials immediately and detaches after the pending command settles', () => {
  const harness = setup(createSessionCredentialStoreSpy(), true);
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
  expect(harness.session.dispose).not.toHaveBeenCalled();
  harness.rerender({ commandPending: true });
  expect(harness.session.dispose).not.toHaveBeenCalled();
  harness.rerender({ commandPending: false });
  expect(harness.session.dispose).toHaveBeenCalledOnce();
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
});

test('Result return clears immediately while a command is pending', () => {
  const harness = setup(createSessionCredentialStoreSpy(), true);
  act(() => harness.result.current());
  expect(harness.sessions.clear).toHaveBeenCalledOnce();
  expect(harness.sessionCredentialStore.removeRoom).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: '/lobby' });
});

test('returns to Lobby even when the real browser storage cannot remove the credential', () => {
  const removeItem = vi.fn(() => {
    throw new Error('storage denied');
  });
  const actual = createSessionCredentialStore({
    storage: { getItem: () => null, setItem() {}, removeItem },
  });
  actual.recordRoom(authority);
  const sessionCredentialStore = {
    ...createSessionCredentialStoreSpy(),
    removeRoom: vi.fn(actual.removeRoom),
  };
  const harness = setup(sessionCredentialStore);
  expect(removeItem).toHaveBeenCalledOnce();
  expect(actual.initialize().recentRoom).toEqual({ status: 'ready', room: null });
  act(() => harness.result.current());
  expect(harness.sessions.clear).toHaveBeenCalledOnce();
  expect(navigate).toHaveBeenCalledWith({ to: '/lobby' });
});

test('detaches a replacement finished session independently of the previous Result', async () => {
  const harness = setup();
  await waitFor(() => expect(harness.session.dispose).toHaveBeenCalledOnce());
  const replacement = createSessionMock({
    ...harness.session.getSnapshot(),
    game: finishedGame('connectionEnded', 0),
  });
  act(() => harness.sessions.replaceSession(replacement));
  await waitFor(() => expect(replacement.dispose).toHaveBeenCalledOnce());
  expect(harness.sessions.detachFinishedSession).toHaveBeenCalledTimes(2);
  expect(harness.sessions.clear).not.toHaveBeenCalled();
});
