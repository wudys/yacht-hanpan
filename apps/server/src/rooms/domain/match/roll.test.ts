import type { DieFace, DieSlot } from '@repo/yacht-rules';
import { describe, expect, test } from 'bun:test';

import {
  applyRollResult,
  createMatch,
  forfeitMatch,
  MATCH_REJECTION_CODE,
  type MatchDecision,
  planRoll,
  type PlayingMatch,
  type RollApplicationResult,
  type RollPlan,
  turnId,
} from '@/rooms/domain/match';
import { epochMilliseconds } from '@/rooms/domain/time';

const creatorIndex = 0 as const;
const joinerIndex = 1 as const;
const firstTurnId = turnId('turn-1');
const startedAt = epochMilliseconds(1_000);

function initialMatch(): PlayingMatch {
  return createMatch({
    initialTurn: { id: firstTurnId, startedAt },
  });
}

function unwrapDecision<T>(decision: MatchDecision<T>): T {
  expect(decision.ok).toBe(true);
  if (!decision.ok) throw new Error(decision.code);
  return decision.value;
}

function unwrapTransition(transition: RollApplicationResult): PlayingMatch {
  expect(transition.ok).toBe(true);
  if (!transition.ok) throw new Error(transition.reason);
  expect(transition.match.status).toBe('playing');
  if (transition.match.status !== 'playing') throw new Error('Expected playing');
  return transition.match;
}

function planFirstRoll(match: PlayingMatch = initialMatch()): RollPlan {
  return unwrapDecision(
    planRoll(match, {
      seatIndex: creatorIndex,
      turnId: firstTurnId,
      receivedAt: epochMilliseconds(1_001),
    }),
  );
}

function applyFirstRoll(match: PlayingMatch = initialMatch()): PlayingMatch {
  return unwrapTransition(
    applyRollResult(match, {
      plan: planFirstRoll(match),
      facesBySlot: [
        { slot: 0, value: 1 },
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    }),
  );
}

function withHeldSlots(match: PlayingMatch, heldSlots: readonly DieSlot[]): PlayingMatch {
  return {
    ...match,
    currentTurn: {
      ...match.currentTurn,
      heldSlots: [...heldSlots],
    },
  };
}

describe('Yacht match construction and roll lifecycle', () => {
  test('creates a creator-first match with one full 90-second turn', () => {
    const match = initialMatch();

    expect(match).toEqual({
      status: 'playing',
      players: [
        { scorecard: {}, timeoutCount: 0 },
        { scorecard: {}, timeoutCount: 0 },
      ],
      currentTurn: {
        id: firstTurnId,
        seatIndex: creatorIndex,
        startedAt,
        deadlineAt: epochMilliseconds(91_000),
        heldSlots: [],
        diceState: { rollCount: 0, dice: null },
      },
    });
  });

  test('plans all five slots on the first roll without changing the match', () => {
    const match = initialMatch();
    const plan = planFirstRoll(match);

    expect(plan).toEqual({
      turnId: firstTurnId,
      seatIndex: creatorIndex,
      rollCountBefore: 0,
      rollingSlots: [0, 1, 2, 3, 4],
    });
    expect(match.currentTurn.diceState).toEqual({ rollCount: 0, dice: null });
  });

  test('commits an authoritative first-roll result exactly once', () => {
    const match = initialMatch();
    const transition = applyRollResult(match, {
      plan: planFirstRoll(match),
      facesBySlot: [
        { slot: 0, value: 6 },
        { slot: 1, value: 5 },
        { slot: 2, value: 4 },
        { slot: 3, value: 3 },
        { slot: 4, value: 2 },
      ],
    });

    expect(transition.ok).toBe(true);
    if (!transition.ok || transition.match.status !== 'playing') return;
    expect(transition.changed).toBe(true);
    expect(transition.match.currentTurn.diceState).toEqual({
      rollCount: 1,
      dice: [{ value: 6 }, { value: 5 }, { value: 4 }, { value: 3 }, { value: 2 }],
    });
  });

  test('rerolls only unheld slots and preserves held values', () => {
    const heldMatch = withHeldSlots(applyFirstRoll(), [1, 3]);
    const plan = unwrapDecision(
      planRoll(heldMatch, {
        seatIndex: creatorIndex,
        turnId: firstTurnId,
        receivedAt: epochMilliseconds(2_000),
      }),
    );
    expect(plan.rollingSlots).toEqual([0, 2, 4]);

    const next = unwrapTransition(
      applyRollResult(heldMatch, {
        plan,
        facesBySlot: [
          { slot: 0, value: 6 },
          { slot: 2, value: 6 },
          { slot: 4, value: 6 },
        ],
      }),
    );

    expect(next.currentTurn.diceState).toEqual({
      rollCount: 2,
      dice: [{ value: 6 }, { value: 2 }, { value: 6 }, { value: 4 }, { value: 6 }],
    });
  });

  test('rejects wrong actor, stale turn, and deadline boundary', () => {
    const match = initialMatch();

    expect(
      planRoll(match, {
        seatIndex: joinerIndex,
        turnId: firstTurnId,
        receivedAt: epochMilliseconds(2_000),
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.NOT_YOUR_TURN });
    expect(
      planRoll(match, {
        seatIndex: creatorIndex,
        turnId: turnId('stale'),
        receivedAt: epochMilliseconds(2_000),
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.STALE_TURN });
    expect(
      planRoll(match, {
        seatIndex: creatorIndex,
        turnId: firstTurnId,
        receivedAt: epochMilliseconds(91_000),
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.TURN_EXPIRED });
  });

  test('rejects reroll with all dice held and a fourth roll', () => {
    const allHeld = withHeldSlots(applyFirstRoll(), [0, 1, 2, 3, 4]);
    expect(
      planRoll(allHeld, {
        seatIndex: creatorIndex,
        turnId: firstTurnId,
        receivedAt: epochMilliseconds(2_000),
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.NO_DICE_TO_ROLL });

    const rolled = applyFirstRoll();
    if (rolled.currentTurn.diceState.dice === null) throw new Error('Expected dice');
    const threeRolls: PlayingMatch = {
      ...rolled,
      currentTurn: {
        ...rolled.currentTurn,
        diceState: { rollCount: 3, dice: rolled.currentTurn.diceState.dice },
      },
    };
    expect(
      planRoll(threeRolls, {
        seatIndex: creatorIndex,
        turnId: firstTurnId,
        receivedAt: epochMilliseconds(2_000),
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.ROLL_LIMIT_REACHED });
  });

  test('does not apply a planned roll after the match has finished', () => {
    const current = initialMatch();
    const plan = planFirstRoll(current);
    const finished = forfeitMatch(current, { forfeitingSeatIndex: creatorIndex });
    if (!finished.ok || finished.match.status !== 'finished') throw new Error('Expected finished');

    const result = applyRollResult(finished.match, {
      plan,
      facesBySlot: [
        { slot: 0, value: 1 },
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      changed: false,
      reason: 'matchNotPlaying',
    });
    expect(result.match).toBe(finished.match);
  });

  test('does not consume a roll for invalid or stale worker results', () => {
    const match = initialMatch();
    const plan = planFirstRoll(match);
    const invalid = applyRollResult(match, {
      plan,
      facesBySlot: [
        { slot: 0, value: 1 },
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
      ],
    });
    expect(invalid).toMatchObject({
      ok: false,
      changed: false,
      reason: 'invalidResult',
      match,
    });

    const alreadyRolled = applyFirstRoll(match);
    const stale = applyRollResult(alreadyRolled, {
      plan,
      facesBySlot: [
        { slot: 0, value: 1 },
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    });
    expect(stale).toMatchObject({
      ok: false,
      changed: false,
      reason: 'planMismatch',
    });
    expect(stale.match).toBe(alreadyRolled);
  });

  test.each([
    [
      'duplicate slots',
      [
        { slot: 0, value: 1 },
        { slot: 0, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    ],
    [
      'an invalid face',
      [
        { slot: 0, value: 1 },
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 7 },
      ],
    ],
    [
      'an out-of-range slot',
      [
        { slot: 0, value: 1 },
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 5, value: 5 },
      ],
    ],
  ])('rejects %s in authoritative roll results without consuming a roll', (_label, faces) => {
    const match = initialMatch();
    const plan = planFirstRoll(match);
    const facesBySlot = faces as unknown as readonly {
      readonly slot: DieSlot;
      readonly value: DieFace;
    }[];
    const rejected = applyRollResult(match, { plan, facesBySlot });

    expect(rejected).toMatchObject({
      ok: false,
      changed: false,
      reason: 'invalidResult',
    });
    expect(rejected.match).toBe(match);
    expect(match.currentTurn.diceState).toEqual({ rollCount: 0, dice: null });
  });
});
