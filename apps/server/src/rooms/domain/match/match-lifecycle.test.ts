import { CATEGORY_ID, CATEGORY_IDS, type Scorecard, type SeatIndex } from '@repo/yacht-rules';
import { describe, expect, test } from 'bun:test';

import {
  applyRollResult,
  createMatch,
  endMatchForConnection,
  evaluateTurnExpiry,
  expireTurn,
  forfeitMatch,
  MATCH_REJECTION_CODE,
  planRoll,
  type PlayingMatch,
  selectScoreCategory,
  turnId,
} from '@/rooms/domain/match';
import { epochMilliseconds } from '@/rooms/domain/time';

const creatorIndex = 0 as const;
const joinerIndex = 1 as const;

function initialMatch(): PlayingMatch {
  return createMatch({
    initialTurn: { id: turnId('turn-1'), startedAt: epochMilliseconds(1_000) },
  });
}

function createRolledMatch(): PlayingMatch {
  const match = initialMatch();
  const plan = planRoll(match, {
    seatIndex: creatorIndex,
    turnId: turnId('turn-1'),
    receivedAt: epochMilliseconds(1_001),
  });
  if (!plan.ok) throw new Error(plan.code);
  const rolled = applyRollResult(match, {
    plan: plan.value,
    facesBySlot: [
      { slot: 0, value: 1 },
      { slot: 1, value: 2 },
      { slot: 2, value: 3 },
      { slot: 3, value: 4 },
      { slot: 4, value: 5 },
    ],
  });
  if (!rolled.ok || rolled.match.status !== 'playing') {
    throw new Error('Expected rolled playing match');
  }
  return rolled.match;
}

describe('turn expiration', () => {
  test.each([60_999, 61_000, 61_001])(
    'evaluates expiry at %d without a next turn or input mutation',
    (checkedAt) => {
      const match = initialMatch();
      const before = structuredClone(match);
      const decision = evaluateTurnExpiry(match, {
        expectedTurnId: match.currentTurn.id,
        checkedAt: epochMilliseconds(checkedAt),
      });
      expect(decision).toEqual(
        checkedAt < 61_000
          ? { kind: 'rejected', code: MATCH_REJECTION_CODE.TURN_NOT_EXPIRED }
          : {
              kind: 'advance',
              players: [
                { scorecard: {}, timeoutCount: 1 },
                { scorecard: {}, timeoutCount: 0 },
              ],
              nextSeatIndex: 1,
            },
      );
      expect(match).toEqual(before);
    },
  );

  test('consumes a turn without recording a category and starts a full next turn', () => {
    const transition = expireTurn(initialMatch(), {
      expectedTurnId: turnId('turn-1'),
      checkedAt: epochMilliseconds(61_000),
      nextTurn: { id: turnId('turn-2'), startedAt: epochMilliseconds(62_000) },
    });

    expect(transition).toMatchObject({
      ok: true,
      changed: true,
      match: {
        status: 'playing',
        players: [
          { scorecard: {}, timeoutCount: 1 },
          { scorecard: {}, timeoutCount: 0 },
        ],
        currentTurn: {
          id: turnId('turn-2'),
          seatIndex: joinerIndex,
          startedAt: epochMilliseconds(62_000),
          deadlineAt: epochMilliseconds(122_000),
          diceState: { rollCount: 0, dice: null },
        },
      },
    });
  });

  test('rejects a stale timer and a check before the deadline', () => {
    expect(
      expireTurn(initialMatch(), {
        expectedTurnId: turnId('stale'),
        checkedAt: epochMilliseconds(61_000),
        nextTurn: { id: turnId('turn-2'), startedAt: epochMilliseconds(62_000) },
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.STALE_TURN });
    expect(
      expireTurn(initialMatch(), {
        expectedTurnId: turnId('turn-1'),
        checkedAt: epochMilliseconds(60_999),
        nextTurn: { id: turnId('turn-2'), startedAt: epochMilliseconds(62_000) },
      }),
    ).toMatchObject({
      ok: false,
      code: MATCH_REJECTION_CODE.TURN_NOT_EXPIRED,
    });
  });

  test.each([0, 9])(
    'finishes with timeoutLimit on the third timeout after %d scores',
    (scoreCount) => {
      const match = initialMatch();
      const scorecard = Object.fromEntries(
        CATEGORY_IDS.slice(0, scoreCount).map((categoryId) => [categoryId, 1]),
      ) as Scorecard;
      const otherScorecard =
        scoreCount === 0
          ? match.players[1].scorecard
          : (Object.fromEntries(CATEGORY_IDS.map((categoryId) => [categoryId, 0])) as Scorecard);
      const beforeThird: PlayingMatch = {
        ...match,
        players: [
          { ...match.players[0], scorecard, timeoutCount: 2 },
          { ...match.players[1], scorecard: otherScorecard },
        ],
      };

      const transition = expireTurn(beforeThird, {
        expectedTurnId: turnId('turn-1'),
        checkedAt: epochMilliseconds(61_000),
        nextTurn: { id: turnId('unused'), startedAt: epochMilliseconds(62_000) },
      });

      expect(transition).toMatchObject({
        ok: true,
        match: {
          status: 'finished',
          result: {
            reason: 'timeoutLimit',
            winnerSeatIndex: joinerIndex,
          },
        },
      });
    },
  );

  test('finishes by scoresCompleted when a non-third timeout uses both final turns', () => {
    const elevenCategories = Object.fromEntries(
      CATEGORY_IDS.filter((categoryId) => categoryId !== CATEGORY_ID.YACHT).map((categoryId) => [
        categoryId,
        1,
      ]),
    ) as Scorecard;
    const twelveCategories = {
      ...elevenCategories,
      [CATEGORY_ID.YACHT]: 50,
    } satisfies Scorecard;
    const match = initialMatch();
    const finalTurn: PlayingMatch = {
      ...match,
      players: [
        { ...match.players[0], scorecard: elevenCategories },
        { ...match.players[1], scorecard: twelveCategories },
      ],
    };

    expect(
      expireTurn(finalTurn, {
        expectedTurnId: turnId('turn-1'),
        checkedAt: epochMilliseconds(61_000),
        nextTurn: { id: turnId('unused'), startedAt: epochMilliseconds(62_000) },
      }),
    ).toMatchObject({
      ok: true,
      match: {
        status: 'finished',
        result: { reason: 'scoresCompleted', winnerSeatIndex: joinerIndex },
      },
    });
  });
});

describe('player-loss transitions', () => {
  test('records an explicit forfeit independently from turn actor and deadline', () => {
    const transition = forfeitMatch(initialMatch(), {
      forfeitingSeatIndex: joinerIndex,
    });

    expect(transition).toMatchObject({
      ok: true,
      changed: true,
      match: {
        status: 'finished',
        result: { reason: 'explicitForfeit', winnerSeatIndex: creatorIndex },
      },
    });
  });

  test('records a connection loss independently from turn actor and deadline', () => {
    const transition = endMatchForConnection(initialMatch(), {
      disconnectedSeatIndex: joinerIndex,
    });

    expect(transition).toMatchObject({
      ok: true,
      changed: true,
      match: {
        status: 'finished',
        result: { reason: 'connectionEnded', winnerSeatIndex: creatorIndex },
      },
    });
  });

  test('rejects non-member loss causes and every transition after finish', () => {
    expect(
      forfeitMatch(initialMatch(), {
        forfeitingSeatIndex: 2 as SeatIndex,
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.INVALID_PLAYER });
    expect(
      endMatchForConnection(initialMatch(), {
        disconnectedSeatIndex: 2 as SeatIndex,
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.INVALID_PLAYER });

    const finished = forfeitMatch(initialMatch(), {
      forfeitingSeatIndex: joinerIndex,
    });
    if (!finished.ok) throw new Error(finished.code);
    expect(
      endMatchForConnection(finished.match, {
        disconnectedSeatIndex: creatorIndex,
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.MATCH_FINISHED });
    expect(
      expireTurn(finished.match, {
        expectedTurnId: turnId('turn-1'),
        checkedAt: epochMilliseconds(61_000),
        nextTurn: { id: turnId('unused'), startedAt: epochMilliseconds(62_000) },
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.MATCH_FINISHED });
  });
});

describe('deadline boundary', () => {
  test('accepts a last score before deadline and rejects it at the deadline', () => {
    const rolled = createRolledMatch();
    const beforeDeadline = selectScoreCategory(rolled, {
      seatIndex: creatorIndex,
      turnId: turnId('turn-1'),
      receivedAt: epochMilliseconds(60_999),
      categoryId: CATEGORY_ID.CHOICE,
      nextTurn: { id: turnId('turn-2'), startedAt: epochMilliseconds(61_100) },
    });
    expect(beforeDeadline.ok).toBe(true);

    expect(
      selectScoreCategory(rolled, {
        seatIndex: creatorIndex,
        turnId: turnId('turn-1'),
        receivedAt: epochMilliseconds(61_000),
        categoryId: CATEGORY_ID.CHOICE,
        nextTurn: { id: turnId('turn-2'), startedAt: epochMilliseconds(61_100) },
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.TURN_EXPIRED });
    expect(
      expireTurn(rolled, {
        expectedTurnId: turnId('turn-1'),
        checkedAt: epochMilliseconds(61_000),
        nextTurn: { id: turnId('turn-2'), startedAt: epochMilliseconds(61_100) },
      }),
    ).toMatchObject({ ok: true });
  });
});
