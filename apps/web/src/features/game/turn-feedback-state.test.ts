import type { GamePresentation } from '@repo/game-client-sdk/session';
import { parseGameSnapshot } from '@repo/game-protocol/socket';
import { expect, test } from 'vitest';

import {
  advanceTurnFeedback,
  createTurnFeedbackState,
  type TurnFeedbackInput,
} from '@/features/game/turn-feedback-state';
import { playingGameInput } from '@/testing/game-fixtures';

const session = {};
const game = parseGameSnapshot({
  stateVersion: 8,
  match: {
    status: 'playing',
    players: [
      { scorecard: { threes: 15, fours: 20, fives: 10, sixes: 18 }, timeoutCount: 0 },
      { scorecard: {}, timeoutCount: 0 },
    ],
    currentTurn: {
      turnId: '11111111-1111-4111-8111-000000000002',
      seatIndex: 1,
      startedAt: 1_000,
      deadlineAt: 91_000,
      rollCount: 0,
      dice: null,
      heldSlots: [],
    },
  },
});

const before = parseGameSnapshot(playingGameInput);
if (before.match.status !== 'playing') throw new Error('Expected playing fixture');
const presentation: GamePresentation = {
  kind: 'score',
  record: {
    stateVersion: game.stateVersion,
    completedTurnId: before.match.currentTurn.turnId,
    seatIndex: 0,
    categoryId: 'sixes',
    score: 18,
  },
};

function input(overrides: Partial<TurnFeedbackInput> = {}): TurnFeedbackInput {
  return {
    session,
    game,
    presentation,
    viewerSeat: 1,
    now: 300,
    serverNow: 300,
    suspended: false,
    scoreVisible: true,
    boardVisible: true,
    canStartTurn: true,
    rollPending: false,
    ...overrides,
  };
}

test('keeps a complete local confirmation after a delayed fresh record, then opens one cue', () => {
  const confirmed = advanceTurnFeedback(createTurnFeedbackState(), input());
  expect(confirmed.record).toMatchObject({
    startedAt: 300,
    phase: 'confirming',
    bonusEarned: true,
  });
  expect(confirmed.tabRequest?.group).toBe('upper');
  expect(advanceTurnFeedback(confirmed, input())).toBe(confirmed);
  const outgoing = advanceTurnFeedback(confirmed, input({ now: 1_100, serverNow: 1_100 }));
  expect(outgoing.record?.phase).toBe('outgoing');
  const incoming = advanceTurnFeedback(outgoing, input({ now: 1_200, serverNow: 1_200 }));
  expect(incoming.record?.phase).toBe('incoming');
  const opened = advanceTurnFeedback(incoming, input({ now: 1_300, serverNow: 1_300 }));
  expect(opened.record).toBeNull();
  expect(opened.turnCue).toMatchObject({
    turnId: '11111111-1111-4111-8111-000000000002',
    startedAt: 1_300,
  });
  expect(advanceTurnFeedback(opened, input({ now: 1_950, serverNow: 1_950 })).turnCue).toBeNull();
});

test('consumes a late record without replaying it after a clock correction', () => {
  const skipped = advanceTurnFeedback(
    createTurnFeedbackState(),
    input({ now: 1_000, serverNow: 1_000 }),
  );
  expect(skipped.record).toBeNull();
  expect(skipped.turnCue).toBeNull();
  expect(skipped.tabRequest?.group).toBe('upper');
  expect(advanceTurnFeedback(skipped, input({ serverNow: 900 })).record).toBeNull();
});

test('recovery, a newer game and hidden state discard the old confirmation', () => {
  const active = advanceTurnFeedback(createTurnFeedbackState(), input());
  for (const change of [
    { suspended: true },
    { presentation: { kind: 'settled' } as const },
    { game: parseGameSnapshot({ ...game, stateVersion: 9 }) },
  ]) {
    const cancelled = advanceTurnFeedback(active, input(change));
    expect(cancelled.record).toBeNull();
    expect(advanceTurnFeedback(cancelled, input()).record).toBeNull();
  }
});

test('opening the scoreboard discards visual effects without extending the local deadline', () => {
  const active = advanceTurnFeedback(createTurnFeedbackState(), input());
  const obscured = advanceTurnFeedback(
    active,
    input({ now: 500, scoreVisible: false, boardVisible: false }),
  );
  expect(obscured.record?.visible).toBe(false);
  const reopened = advanceTurnFeedback(obscured, input({ now: 700 }));
  expect(reopened.record?.visible).toBe(false);
  expect(reopened.record?.startedAt).toBe(300);
});

test('a long stall does not replay a missed turn cue, and local roll cancels it', () => {
  const active = advanceTurnFeedback(createTurnFeedbackState(), input());
  const stalled = advanceTurnFeedback(active, input({ now: 3_000, serverNow: 3_000 }));
  expect(stalled.record).toBeNull();
  expect(stalled.turnCue).toBeNull();
  const opened = advanceTurnFeedback(active, input({ now: 1_300, serverNow: 1_300 }));
  expect(advanceTurnFeedback(opened, input({ now: 1_400, rollPending: true })).turnCue).toBeNull();
});

test('waits for an outstanding command before cueing actual input readiness', () => {
  const active = advanceTurnFeedback(createTurnFeedbackState(), input());
  const awaitingReceipt = advanceTurnFeedback(
    active,
    input({
      now: 1_300,
      serverNow: 1_300,
      canStartTurn: false,
    }),
  );
  expect(awaitingReceipt.record).toBeNull();
  expect(awaitingReceipt.turnCue).toBeNull();
  const opened = advanceTurnFeedback(awaitingReceipt, input({ now: 1_400, serverNow: 1_400 }));
  expect(opened.turnCue).toMatchObject({ startedAt: 1_400 });
  expect(advanceTurnFeedback(opened, input({ now: 2_050, serverNow: 2_050 })).turnCue).toBeNull();
});

test('final records confirm locally without constructing a next turn; other endings win immediately', () => {
  const finalGame = parseGameSnapshot({
    stateVersion: 8,
    match: {
      status: 'finished',
      players: game.match.players,
      result: { reason: 'scoresCompleted', winnerSeatIndex: 0 },
    },
  });
  const active = advanceTurnFeedback(
    createTurnFeedbackState(),
    input({ game: finalGame, now: 10_000, serverNow: 10_000 }),
  );
  expect(active.record?.final).toBe(true);
  expect(active.pendingTurn).toBeNull();
  const ended = advanceTurnFeedback(
    active,
    input({ game: finalGame, now: 11_000, serverNow: 11_000 }),
  );
  expect(ended.record).toBeNull();
  expect(ended.turnCue).toBeNull();
});
