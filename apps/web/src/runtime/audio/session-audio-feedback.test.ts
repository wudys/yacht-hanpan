// @vitest-environment jsdom
import type { CommandResult } from '@repo/game-client-sdk';
import { afterEach, expect, test, vi } from 'vitest';

import { AUDIO_CUE } from '@/runtime/audio/cue-runtime';
import {
  type HoldReceiptObservation,
  startSessionAudioFeedback,
} from '@/runtime/audio/session-audio-feedback';
import { createPreferencesStore } from '@/runtime/preferences/preferences-store';
import { commandSuccess, playingGameInput as playingGame } from '@/testing/game-fixtures';
import {
  createAudioMock,
  createGameSessionHarness,
  createRecoveryFake,
  createSessionMock,
  deferred,
} from '@/testing/game-harness';

const disposers = new Set<() => void>();
afterEach(() => {
  disposers.forEach((dispose) => dispose());
  disposers.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(now: () => number = () => 10_000) {
  const harness = createGameSessionHarness();
  const audio = createAudioMock();
  const recovery = createRecoveryFake();
  const preferences = createPreferencesStore({ getItem: () => null, setItem: () => {} });
  const feedback = startSessionAudioFeedback({
    ...harness,
    audio,
    recovery,
    preferences,
    clock: { now },
  });
  disposers.add(feedback.dispose);
  const observe = (
    result: Promise<CommandResult>,
    cue: HoldReceiptObservation['cue'] = AUDIO_CUE.HOLD,
  ) =>
    feedback.observeHoldReceipt({
      session: harness.sessions.getSnapshot().session,
      syncRevision: harness.sessions.getSnapshot().sessionSnapshot.syncRevision,
      result,
      cue,
    });
  const publish = () => harness.sessions.publish({ ...playingGame, stateVersion: 8 });
  return { ...harness, audio, recovery, preferences, feedback, observe, publish };
}

test('countdown ticks warn once at 5 through 1 seconds without session publication', () => {
  vi.useFakeTimers();
  vi.setSystemTime(playingGame.match.currentTurn.deadlineAt - 6_000);
  const h = setup(() => Date.now());
  const snapshot = h.sessions.getSnapshot();
  expect(h.audio.playCue).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1_000);
  for (const seconds of [5, 4, 3, 2, 1]) {
    expect(h.audio.playCue).toHaveBeenCalledTimes(6 - seconds);
    expect(h.audio.playCue).toHaveBeenLastCalledWith(AUDIO_CUE.TIMER_WARNING);
    vi.advanceTimersByTime(750);
    expect(h.audio.playCue).toHaveBeenCalledTimes(6 - seconds);
    vi.advanceTimersByTime(250);
  }
  expect(h.audio.playCue).toHaveBeenCalledTimes(5);
  vi.advanceTimersByTime(1_000);
  expect(h.audio.playCue).toHaveBeenCalledTimes(5);
  expect(h.sessions.getSnapshot()).toBe(snapshot);
});

test('disposal cancels countdown warnings before the remaining boundaries', () => {
  vi.useFakeTimers();
  vi.setSystemTime(playingGame.match.currentTurn.deadlineAt - 6_000);
  const h = setup(() => Date.now());
  vi.advanceTimersByTime(1_000);
  expect(h.audio.playCue).toHaveBeenCalledExactlyOnceWith(AUDIO_CUE.TIMER_WARNING);
  h.feedback.dispose();
  vi.advanceTimersByTime(5_000);
  expect(h.audio.playCue).toHaveBeenCalledTimes(1);
});

test.each(
  (['command-view', 'live-view'] as const).flatMap((order) =>
    [AUDIO_CUE.HOLD, AUDIO_CUE.RELEASE].map((cue) => ({ order, cue })),
  ),
)('$order confirms $cue once when the original hold receipt arrives', async ({ order, cue }) => {
  const h = setup();
  const response = deferred<CommandResult>();
  h.observe(response.promise, cue);
  if (order === 'live-view') {
    h.publish();
    await Promise.resolve();
  }
  expect(h.audio.playCue).not.toHaveBeenCalled();
  h.publish();
  response.resolve(commandSuccess());
  await response.promise;
  h.publish();
  expect(h.audio.playCue).toHaveBeenCalledExactlyOnceWith(cue);
});

test.each(
  (['off', 'hidden', 'surface', 'recovery', 'replacement', 'sync', 'dispose'] as const).flatMap(
    (reason) => [false, true].map((completed) => ({ reason, completed })),
  ),
)(
  '$reason preserves cue cancellation and one-time completion (receipt already received: $completed)',
  async ({ reason, completed }) => {
    const h = setup();
    const response = deferred<CommandResult>();
    const command: HoldReceiptObservation = {
      session: h.session,
      syncRevision: h.sessions.getSnapshot().sessionSnapshot.syncRevision,
      result: response.promise,
      cue: AUDIO_CUE.HOLD,
    };
    h.feedback.observeHoldReceipt(command);
    h.publish();
    expect(h.audio.playCue).not.toHaveBeenCalled();
    if (completed) {
      response.resolve(commandSuccess());
      await response.promise;
      expect(h.audio.playCue).toHaveBeenCalledExactlyOnceWith(AUDIO_CUE.HOLD);
    }
    if (reason === 'off') {
      h.preferences.setSfxEnabled(false);
      h.preferences.setSfxEnabled(true);
    }
    if (reason === 'hidden') {
      const hidden = vi.spyOn(document, 'hidden', 'get');
      hidden.mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event('visibilitychange'));
    }
    if (reason === 'surface') {
      h.feedback.setSurfaceExposed(false);
      h.feedback.setSurfaceExposed(true);
    }
    if (reason === 'recovery') {
      h.recovery.publish({ status: 'synchronizing' });
      h.recovery.publish({ status: 'idle' });
    }
    if (reason === 'replacement') h.sessions.replaceSession(createSessionMock());
    if (reason === 'sync') {
      const snapshot = h.session.getSnapshot();
      h.session.getSnapshot.mockReturnValue({
        ...snapshot,
        syncRevision: snapshot.syncRevision + 1,
      });
      h.sessions.replaceSession(h.session);
    }
    if (reason === 'dispose') {
      h.feedback.dispose();
      h.feedback.dispose();
    }
    h.publish();
    response.resolve(commandSuccess());
    await response.promise;
    if (completed) {
      h.feedback.observeHoldReceipt(command);
      await Promise.resolve();
    }
    expect(h.audio.playCue).toHaveBeenCalledTimes(completed ? 1 : 0);
  },
);

test.each(['covered', 'restored'] as const)(
  'a command completed while %s keeps its result and cannot replay after return',
  async (completedWhile) => {
    const h = setup();
    const response = deferred<CommandResult>();
    h.feedback.setSurfaceExposed(false);
    h.feedback.setSurfaceExposed(false);
    h.observe(response.promise);
    h.publish();
    if (completedWhile === 'restored') h.feedback.setSurfaceExposed(true);
    const result = commandSuccess();
    response.resolve(result);
    await expect(response.promise).resolves.toBe(result);
    h.feedback.setSurfaceExposed(true);
    expect(h.audio.playCue).not.toHaveBeenCalled();

    h.observe(
      Promise.resolve({
        ...commandSuccess(),
        actionId: '019976a2-d8d8-7000-8000-000000000002',
      }),
    );
    await Promise.resolve();
    expect(h.audio.playCue).toHaveBeenCalledExactlyOnceWith(AUDIO_CUE.HOLD);
    h.feedback.dispose();
    h.feedback.setSurfaceExposed(false);
    h.feedback.setSurfaceExposed(true);
  },
);

test('surface suppression consumes warning seconds and resumes only at the next fresh boundary', () => {
  vi.useFakeTimers();
  const deadline = playingGame.match.currentTurn.deadlineAt;
  vi.setSystemTime(deadline - 6_000);
  const h = setup(() => Date.now());
  vi.advanceTimersByTime(1_000);
  expect(h.audio.playCue).toHaveBeenCalledExactlyOnceWith(AUDIO_CUE.TIMER_WARNING);
  const stops = vi.mocked(h.audio.stopCue).mock.calls.length;
  h.feedback.setSurfaceExposed(false);
  expect(h.audio.stopCue).toHaveBeenCalledTimes(stops + 1);
  expect(h.audio.stopCue).toHaveBeenLastCalledWith(AUDIO_CUE.TIMER_WARNING);
  vi.advanceTimersByTime(2_000);
  expect(h.audio.playCue).toHaveBeenCalledTimes(1);
  h.feedback.setSurfaceExposed(true);
  h.feedback.setSurfaceExposed(true);
  expect(h.audio.playCue).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1_000);
  expect(h.audio.playCue).toHaveBeenCalledTimes(2);

  vi.setSystemTime(deadline - 4_000);
  vi.advanceTimersByTime(2_000);
  expect(h.audio.playCue).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1_000);
  expect(h.audio.playCue).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(1_000);
  expect(h.audio.playCue).toHaveBeenCalledTimes(3);
});

test('deduplicates repeated promises and distinct successful results for the same action', async () => {
  const h = setup();
  const response = deferred<CommandResult>();
  h.observe(response.promise);
  h.observe(response.promise);
  h.publish();
  h.observe(Promise.resolve(commandSuccess()));
  response.resolve(commandSuccess());
  await response.promise;
  expect(h.audio.playCue).toHaveBeenCalledExactlyOnceWith(AUDIO_CUE.HOLD);
  h.sessions.replaceSession(createSessionMock());
  h.publish();
  h.observe(Promise.resolve(commandSuccess()));
  await Promise.resolve();
  expect(h.audio.playCue).toHaveBeenCalledTimes(2);
});

test('failure and rejected promises are consumed without cue or unhandled rejection', async () => {
  const h = setup();
  h.observe(Promise.resolve({ ok: false, error: { kind: 'protocol', code: 'STATE_UNAVAILABLE' } }));
  h.observe(Promise.reject(new Error('transport')));
  await Promise.resolve();
  h.publish();
  expect(h.audio.playCue).not.toHaveBeenCalled();
});

test('does not enqueue while disabled or after disposal', async () => {
  const h = setup();
  h.publish();
  h.preferences.setSfxEnabled(false);
  h.observe(Promise.resolve(commandSuccess()));
  h.preferences.setSfxEnabled(true);
  h.publish();
  await Promise.resolve();
  h.feedback.dispose();
  h.observe(Promise.resolve(commandSuccess()));
  await Promise.resolve();
  expect(h.audio.playCue).not.toHaveBeenCalled();
});

test('uses one subscription per source and releases every subscription on repeated disposal', async () => {
  const h = createGameSessionHarness();
  const recovery = createRecoveryFake();
  const preferences = createPreferencesStore({ getItem: () => null, setItem: () => {} });
  const unsubscribers: ReturnType<typeof vi.fn>[] = [];
  const sources = [h.sessions, recovery, preferences];
  const subscriptions = sources.map((source) => {
    const { subscribe } = source;
    return vi.spyOn(source, 'subscribe').mockImplementation((listener) => {
      const unsubscribe = vi.fn(subscribe(listener));
      unsubscribers.push(unsubscribe);
      return unsubscribe;
    });
  });
  const addListener = vi.spyOn(document, 'addEventListener');
  const removeListener = vi.spyOn(document, 'removeEventListener');
  const clearInterval = vi.spyOn(window, 'clearInterval');
  const audio = createAudioMock();
  const feedback = startSessionAudioFeedback({
    ...h,
    audio,
    recovery,
    preferences,
    clock: { now: () => 10_000 },
  });
  disposers.add(feedback.dispose);
  const response = deferred<CommandResult>();
  for (let index = 0; index < 3; index += 1) {
    feedback.observeHoldReceipt({
      session: h.session,
      syncRevision: 1,
      result: response.promise,
      cue: AUDIO_CUE.HOLD,
    });
  }
  subscriptions.forEach((subscribe) => expect(subscribe).toHaveBeenCalledOnce());
  const visibility = addListener.mock.calls.find(([event]) => event === 'visibilitychange');
  expect(visibility).toBeDefined();
  feedback.dispose();
  feedback.dispose();
  unsubscribers.forEach((unsubscribe) => expect(unsubscribe).toHaveBeenCalledOnce());
  expect(removeListener).toHaveBeenCalledWith('visibilitychange', visibility?.[1]);
  expect(clearInterval).toHaveBeenCalledOnce();
  h.sessions.publish({ ...playingGame, stateVersion: 8 });
  response.resolve(commandSuccess());
  await response.promise;
  expect(audio.playCue).not.toHaveBeenCalled();
});
