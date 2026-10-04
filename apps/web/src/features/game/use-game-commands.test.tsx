// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- hook subscriptions must stop between tests. */
import type { CommandResult } from '@repo/game-client-sdk';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { useGameCommands } from '@/features/game/use-game-commands';
import { startGameAudioFeedback } from '@/runtime/audio/game-audio-feedback';
import { PRODUCT_CUE } from '@/runtime/audio/product-cues';
import { createProductPreferences } from '@/runtime/preferences/product-preferences';
import { observeTelemetry } from '@/runtime/telemetry/observe-telemetry';
import { inactiveTelemetry } from '@/runtime/telemetry/telemetry';
import { TelemetryContext } from '@/runtime/telemetry/TelemetryContext';
import {
  commandSuccess,
  finishedGame,
  playingGameInput as playingGame,
} from '@/testing/game-fixtures';
import {
  createAudio,
  createGameSessionHarness,
  createRecovery,
  createSession,
  deferred,
} from '@/testing/game-harness';

const feedbackDisposers = new Set<() => void>();
afterEach(() => {
  cleanup();
  feedbackDisposers.forEach((dispose) => dispose());
  feedbackDisposers.clear();
});
function setup() {
  const harness = createGameSessionHarness();
  const audio = createAudio();
  const recovery = createRecovery();
  const preferences = createProductPreferences({ getItem: () => null, setItem: () => {} });
  const feedback = startGameAudioFeedback({
    audio,
    sessions: harness.sessions,
    recovery,
    preferences,
    clock: { now: () => 10_000 },
  });
  feedbackDisposers.add(feedback.dispose);
  const report = vi.fn();
  const { result } = renderHook(
    () => useGameCommands(harness.sessions, recovery, audio, feedback),
    {
      wrapper: ({ children }) => (
        <TelemetryContext.Provider value={{ ...inactiveTelemetry, reportUnexpected: report }}>
          {children}
        </TelemetryContext.Provider>
      ),
    },
  );
  return { ...harness, audio, recovery, result, report, feedback };
}

test('releases the command lock after an SDK command rejection', async () => {
  const harness = setup();
  act(() => harness.result.current.roll());
  await act(async () =>
    harness.roll.resolve({ ok: false, error: { kind: 'protocol', code: 'STATE_UNAVAILABLE' } }),
  );
  expect(harness.report).not.toHaveBeenCalled();
  expect(harness.recovery.reportCommandError).toHaveBeenCalledWith({
    kind: 'protocol',
    code: 'STATE_UNAVAILABLE',
  });
  act(() => harness.result.current.roll());
  expect(harness.session.rollDice).toHaveBeenCalledTimes(2);
});

test('does not report a late command rejection from a replaced session', async () => {
  const harness = setup();
  act(() => harness.result.current.roll());
  act(() => harness.sessions.replaceSession(createSession()));
  await act(async () =>
    harness.roll.resolve({ ok: false, error: { kind: 'protocol', code: 'STATE_UNAVAILABLE' } }),
  );
  expect(harness.recovery.reportCommandError).not.toHaveBeenCalled();
  expect(harness.report).not.toHaveBeenCalled();
});

test('reports a contract failure once when the SDK publishes the command error first', async () => {
  const harness = setup();
  const stop = observeTelemetry({
    telemetry: { ...inactiveTelemetry, reportUnexpected: harness.report },
    sessions: harness.sessions,
    recovery: harness.recovery,
    restore: {
      getSnapshot: () => ({ status: 'idle' }),
      subscribe: () => () => {},
      subscribeAttempt: () => () => {},
      check() {},
      dispose() {},
      completeHandoff() {},
      confirmPermanentFailure() {},
    },
  });
  feedbackDisposers.add(stop);
  const error = { kind: 'protocol', code: 'INVALID_RESPONSE' } as const;
  act(() => {
    harness.result.current.roll();
    harness.session.getSnapshot.mockReturnValue({ ...harness.session.getSnapshot(), error });
    harness.sessions.replaceSession(harness.session);
  });
  await act(async () => harness.roll.resolve({ ok: false, error }));
  expect(harness.report).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: 'INVALID_RESPONSE' }),
    { error_code: 'INVALID_RESPONSE', operation: 'synchronize', stage: 'snapshot' },
  );
});

test('reports a command-only contract failure at the response boundary', async () => {
  const harness = setup();
  act(() => harness.result.current.roll());
  await act(async () =>
    harness.roll.resolve({ ok: false, error: { kind: 'protocol', code: 'INVALID_RESPONSE' } }),
  );
  expect(harness.report).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: 'INVALID_RESPONSE' }),
    { error_code: 'INVALID_RESPONSE', operation: 'roll', stage: 'response' },
  );
});

test('releases the command lock when the session promise rejects unexpectedly', async () => {
  const harness = setup();
  act(() => harness.result.current.roll());
  const failure = new Error('session failure');
  await act(async () => harness.roll.reject(failure));
  expect(harness.report).toHaveBeenCalledWith(failure, {
    operation: 'roll',
    stage: 'promise',
  });
  act(() => harness.result.current.roll());
  expect(harness.session.rollDice).toHaveBeenCalledTimes(2);
});

test('submits an intent retained across renders to the current session until its committed success', async () => {
  const harness = setup();
  const { roll } = harness.result.current;
  const response = deferred<CommandResult>();
  const replacement = createSession();
  replacement.rollDice.mockImplementation(() => response.promise);
  act(() => harness.sessions.replaceSession(replacement));
  act(() => {
    roll();
    roll();
  });
  expect(harness.session.rollDice).not.toHaveBeenCalled();
  expect(replacement.rollDice).toHaveBeenCalledOnce();
  expect(harness.result.current.pendingCommandKind).toBe('roll');
  expect(harness.audio.playCue).toHaveBeenCalledWith(PRODUCT_CUE.ROLL_CLICK);
  await act(async () => {
    harness.sessions.publish({ ...playingGame, stateVersion: 8 });
    response.resolve(commandSuccess());
  });
  expect(harness.result.current.holderSnapshot.sessionSnapshot?.game?.stateVersion).toBe(8);
  expect(harness.result.current.pendingCommandKind).toBeNull();
  act(() => roll());
  expect(replacement.rollDice).toHaveBeenCalledTimes(2);
});

test('a finished holder keeps its final snapshot while the original command completes', async () => {
  const harness = setup();
  act(() => harness.result.current.roll());
  const finished = finishedGame('connectionEnded', 1);
  act(() => harness.sessions.publish(finished));
  expect(harness.result.current.pendingCommandKind).toBe('roll');
  await act(async () => {
    harness.roll.resolve(commandSuccess());
    harness.sessions.detachFinishedSession(harness.session);
  });
  expect(harness.session.dispose).toHaveBeenCalledOnce();
  expect(harness.result.current.pendingCommandKind).toBeNull();
  expect(harness.result.current.holderSnapshot.sessionSnapshot?.game).toEqual(finished);
});

test('a late success releases the original command without replacing the new session snapshot', async () => {
  const harness = setup();
  act(() => harness.result.current.roll());
  const replacement = createSession();
  act(() => harness.sessions.publish({ ...playingGame, stateVersion: 8 }));
  expect(harness.result.current.pendingCommandKind).toBe('roll');
  await act(async () => {
    harness.roll.resolve(commandSuccess());
    harness.sessions.replaceSession(replacement);
  });
  expect(harness.result.current.pendingCommandKind).toBeNull();
  expect(harness.result.current.holderSnapshot.session).toBe(replacement);
  expect(harness.result.current.holderSnapshot.sessionSnapshot).toBe(replacement.getSnapshot());
  act(() => harness.result.current.roll());
  expect(replacement.rollDice).toHaveBeenCalledOnce();
});

test('a settled restore keeps the pending command until its original older receipt arrives', async () => {
  const harness = setup();
  act(() => harness.result.current.roll());
  expect(harness.result.current.pendingCommandKind).toBe('roll');
  act(() => harness.recovery.publish({ status: 'synchronizing' }));
  act(() => harness.sessions.publish({ ...playingGame, stateVersion: 10 }));
  expect(harness.result.current.holderSnapshot.sessionSnapshot).toMatchObject({
    game: { stateVersion: 10 },
    presentation: { kind: 'settled' },
  });
  act(() => harness.recovery.publish({ status: 'idle' }));
  expect(harness.result.current.pendingCommandKind).toBe('roll');
  expect(harness.result.current.recoverySnapshot.status).toBe('idle');
  await act(async () => harness.roll.resolve(commandSuccess(8)));
  expect(harness.result.current.pendingCommandKind).toBeNull();
  expect(harness.result.current.holderSnapshot.sessionSnapshot?.game?.stateVersion).toBe(10);
  expect(harness.result.current.holderSnapshot.sessionSnapshot?.presentation).toEqual({
    kind: 'settled',
  });
});

test('clears a retry notice when the SDK capability expires on a session update', async () => {
  const harness = setup();
  let available = true;
  const run = vi.fn(() => Promise.resolve(commandSuccess(playingGame.stateVersion)));
  act(() => harness.result.current.roll());
  await act(async () =>
    harness.roll.resolve({
      ok: false,
      error: { kind: 'server', error: { code: 'ROLL_UNAVAILABLE', params: {} } },
      retry: { isAvailable: () => available, run },
    }),
  );
  expect(harness.result.current.commandRetryError).not.toBeNull();
  available = false;
  act(() =>
    harness.sessions.publish({
      ...playingGame,
      stateVersion: Number(playingGame.stateVersion) + 1,
    }),
  );
  expect(harness.result.current.commandRetryError).toBeNull();
  act(() => harness.result.current.retryCommand());
  expect(run).not.toHaveBeenCalled();
  expect(harness.recovery.reportCommandError).not.toHaveBeenCalled();
});

test.each(['rate-limit', 'retry'] as const)(
  'discards an open %s notice during recovery without reviving it afterward',
  async (notice) => {
    const harness = setup();
    const run = vi.fn(() => Promise.resolve(commandSuccess(playingGame.stateVersion)));
    const rejection: CommandResult =
      notice === 'rate-limit'
        ? {
            ok: false,
            error: {
              kind: 'server',
              error: { code: 'RATE_LIMITED', params: { retryAfterMs: 1_000 } },
            },
          }
        : {
            ok: false,
            error: { kind: 'server', error: { code: 'INTERNAL_ERROR', params: {} } },
            retry: { isAvailable: () => true, run },
          };
    act(() => harness.result.current.roll());
    await act(async () => harness.roll.resolve(rejection));
    expect(
      notice === 'rate-limit'
        ? harness.result.current.rateLimited
        : harness.result.current.commandRetryError !== null,
    ).toBe(true);
    act(() => harness.recovery.publish({ status: 'reconnecting' }));
    expect(harness.result.current.rateLimited).toBe(false);
    expect(harness.result.current.commandRetryError).toBeNull();
    act(() => harness.recovery.publish({ status: 'idle' }));
    expect(harness.result.current.rateLimited).toBe(false);
    expect(harness.result.current.commandRetryError).toBeNull();
    act(() => harness.result.current.retryCommand());
    expect(run).not.toHaveBeenCalled();
  },
);

test.each(['roll', 'hold'] as const)(
  'an expired %s retry leaves no pending command or audio feedback',
  async (kind) => {
    const harness = setup();
    const run = vi.fn(() => null);
    const observe = vi.spyOn(harness.feedback, 'observeCommand');
    const command = kind === 'roll' ? harness.session.rollDice : harness.session.setDieHeld;
    command.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'server', error: { code: 'INTERNAL_ERROR', params: {} } },
      retry: { isAvailable: () => true, run },
    });
    const submit = () =>
      kind === 'roll' ? harness.result.current.roll() : harness.result.current.setDieHeld(0, true);
    await act(async () => submit());
    expect(harness.result.current.commandRetryError).not.toBeNull();
    observe.mockClear();
    harness.audio.playCue.mockClear();
    act(() => harness.result.current.retryCommand());
    expect(run).toHaveBeenCalledOnce();
    expect(harness.result.current.pendingCommandKind).toBeNull();
    expect(harness.result.current.commandRetryError).toBeNull();
    expect(observe).not.toHaveBeenCalled();
    expect(harness.audio.playCue).not.toHaveBeenCalled();
    expect(harness.recovery.reportCommandError).not.toHaveBeenCalled();
    await act(async () => submit());
    expect(command).toHaveBeenCalledTimes(2);
  },
);
