import { CATEGORY_ID, CATEGORY_IDS, type Scorecard } from '@repo/yacht-rules';
import { describe, expect, test } from 'bun:test';

import {
  applyRollResult,
  createMatch,
  MATCH_REJECTION_CODE,
  type MatchDecision,
  type MatchTransition,
  planRoll,
  type PlayingMatch,
  type RollApplicationResult,
  type RollPlan,
  selectScoreCategory,
  setDieHeld,
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

function unwrapDecision<T>(decision: MatchDecision<T>): T {
  if (!decision.ok) throw new Error(decision.code);
  return decision.value;
}

function unwrapPlaying(transition: MatchTransition | RollApplicationResult): PlayingMatch {
  if (!transition.ok) {
    throw new Error('code' in transition ? transition.code : transition.reason);
  }
  if (transition.match.status !== 'playing') throw new Error('Expected playing');
  return transition.match;
}

function rolledMatch(): PlayingMatch {
  const match = initialMatch();
  const plan: RollPlan = unwrapDecision(
    planRoll(match, {
      seatIndex: creatorIndex,
      turnId: turnId('turn-1'),
      receivedAt: epochMilliseconds(1_001),
    }),
  );
  return unwrapPlaying(
    applyRollResult(match, {
      plan,
      facesBySlot: [
        { slot: 0, value: 6 },
        { slot: 1, value: 6 },
        { slot: 2, value: 6 },
        { slot: 3, value: 5 },
        { slot: 4, value: 5 },
      ],
    }),
  );
}

describe('hold transition', () => {
  test('preserves held order through release, rehold, duplicate input and reroll', () => {
    let match = rolledMatch();
    const hold = (slot: number, isHeld: boolean) => {
      match = unwrapPlaying(
        setDieHeld(match, {
          seatIndex: creatorIndex,
          turnId: match.currentTurn.id,
          receivedAt: epochMilliseconds(2_000),
          slot,
          isHeld,
        }),
      );
    };
    hold(3, true);
    hold(0, true);
    hold(1, true);
    expect(match.currentTurn.heldSlots).toEqual([3, 0, 1]);
    const unchanged = match;
    hold(0, true);
    expect(match).toBe(unchanged);
    hold(0, false);
    expect(match.currentTurn.heldSlots).toEqual([3, 1]);
    hold(0, true);
    expect(match.currentTurn.heldSlots).toEqual([3, 1, 0]);
    const plan = unwrapDecision(
      planRoll(match, {
        seatIndex: creatorIndex,
        turnId: match.currentTurn.id,
        receivedAt: epochMilliseconds(2_001),
      }),
    );
    expect(plan.rollingSlots).toEqual([2, 4]);
    match = unwrapPlaying(
      applyRollResult(match, {
        plan,
        facesBySlot: [
          { slot: 2, value: 1 },
          { slot: 4, value: 2 },
        ],
      }),
    );
    expect(match.currentTurn.heldSlots).toEqual([3, 1, 0]);
    expect(match.currentTurn.diceState.dice?.map((die) => die.value)).toEqual([6, 6, 1, 5, 2]);
    hold(4, true);
    hold(2, true);
    const scored = unwrapPlaying(
      selectScoreCategory(match, {
        seatIndex: creatorIndex,
        turnId: match.currentTurn.id,
        receivedAt: epochMilliseconds(2_002),
        categoryId: CATEGORY_ID.CHOICE,
        nextTurn: { id: turnId('turn-2'), startedAt: epochMilliseconds(2_002) },
      }),
    );
    expect(scored.players[0].scorecard.choice).toBe(20);
    expect(scored.currentTurn.heldSlots).toEqual([]);
  });

  test('sets a hold after a roll and returns a no-op for the same target state', () => {
    const match = rolledMatch();
    const held = setDieHeld(match, {
      seatIndex: creatorIndex,
      turnId: turnId('turn-1'),
      receivedAt: epochMilliseconds(2_000),
      slot: 2,
      isHeld: true,
    });

    expect(held).toMatchObject({
      ok: true,
      changed: true,
    });
    const heldMatch = unwrapPlaying(held);
    expect(heldMatch.currentTurn.heldSlots).toEqual([2]);
    expect(heldMatch.currentTurn.diceState).toBe(match.currentTurn.diceState);

    const repeated = setDieHeld(heldMatch, {
      seatIndex: creatorIndex,
      turnId: turnId('turn-1'),
      receivedAt: epochMilliseconds(2_001),
      slot: 2,
      isHeld: true,
    });
    expect(repeated).toEqual({
      ok: true,
      changed: false,
      match: heldMatch,
    });
  });

  test('rejects holds before roll, after roll three, and outside slot range', () => {
    const match = initialMatch();
    const rejected = setDieHeld(match, {
      seatIndex: creatorIndex,
      turnId: turnId('turn-1'),
      receivedAt: epochMilliseconds(2_000),
      slot: 0,
      isHeld: true,
    });
    expect(rejected).toMatchObject({
      ok: false,
      changed: false,
      code: MATCH_REJECTION_CODE.HOLD_NOT_ALLOWED,
    });
    expect(rejected.match).toBe(match);

    const rolled = rolledMatch();
    if (rolled.currentTurn.diceState.dice === null) throw new Error('Expected dice');
    const afterThird: PlayingMatch = {
      ...rolled,
      currentTurn: {
        ...rolled.currentTurn,
        diceState: { rollCount: 3, dice: rolled.currentTurn.diceState.dice },
      },
    };
    expect(
      setDieHeld(afterThird, {
        seatIndex: creatorIndex,
        turnId: turnId('turn-1'),
        receivedAt: epochMilliseconds(2_000),
        slot: 0,
        isHeld: true,
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.HOLD_NOT_ALLOWED });
    expect(
      setDieHeld(rolled, {
        seatIndex: creatorIndex,
        turnId: turnId('turn-1'),
        receivedAt: epochMilliseconds(2_000),
        slot: 5,
        isHeld: true,
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.HOLD_NOT_ALLOWED });
  });
});

describe('score transition', () => {
  test('records a server-calculated score, discards dice, and starts the other turn', () => {
    const match = unwrapPlaying(
      selectScoreCategory(rolledMatch(), {
        seatIndex: creatorIndex,
        turnId: turnId('turn-1'),
        receivedAt: epochMilliseconds(2_000),
        categoryId: CATEGORY_ID.FULL_HOUSE,
        nextTurn: { id: turnId('turn-2'), startedAt: epochMilliseconds(2_100) },
      }),
    );

    expect(match.players[0].scorecard[CATEGORY_ID.FULL_HOUSE]).toBe(28);
    expect(match.currentTurn).toEqual({
      id: turnId('turn-2'),
      seatIndex: joinerIndex,
      startedAt: epochMilliseconds(2_100),
      deadlineAt: epochMilliseconds(92_100),
      heldSlots: [],
      diceState: { rollCount: 0, dice: null },
    });
  });

  test('rejects scoring before roll, invalid category, and recorded category', () => {
    const baseCommand = {
      seatIndex: creatorIndex,
      turnId: turnId('turn-1'),
      receivedAt: epochMilliseconds(2_000),
      nextTurn: { id: turnId('turn-2'), startedAt: epochMilliseconds(2_100) },
    } as const;

    expect(
      selectScoreCategory(initialMatch(), {
        ...baseCommand,
        categoryId: CATEGORY_ID.CHOICE,
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.SCORE_NOT_ALLOWED });
    expect(
      selectScoreCategory(rolledMatch(), {
        ...baseCommand,
        categoryId: 'not-a-category',
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.INVALID_CATEGORY });

    const rolled = rolledMatch();
    const recorded: PlayingMatch = {
      ...rolled,
      players: [
        {
          ...rolled.players[0],
          scorecard: { [CATEGORY_ID.CHOICE]: 0 },
        },
        rolled.players[1],
      ],
    };
    expect(
      selectScoreCategory(recorded, {
        ...baseCommand,
        categoryId: CATEGORY_ID.CHOICE,
      }),
    ).toMatchObject({
      ok: false,
      code: MATCH_REJECTION_CODE.CATEGORY_ALREADY_RECORDED,
    });
  });

  test('rejects the old turn immediately after a successful score', () => {
    const next = unwrapPlaying(
      selectScoreCategory(rolledMatch(), {
        seatIndex: creatorIndex,
        turnId: turnId('turn-1'),
        receivedAt: epochMilliseconds(2_000),
        categoryId: CATEGORY_ID.CHOICE,
        nextTurn: { id: turnId('turn-2'), startedAt: epochMilliseconds(2_100) },
      }),
    );

    expect(
      setDieHeld(next, {
        seatIndex: creatorIndex,
        turnId: turnId('turn-1'),
        receivedAt: epochMilliseconds(2_200),
        slot: 0,
        isHeld: true,
      }),
    ).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.NOT_YOUR_TURN });
  });

  test('finishes with a draw after both players use 12 equal-scoring turns', () => {
    const allButYacht = Object.fromEntries(
      CATEGORY_IDS.filter((categoryId) => categoryId !== CATEGORY_ID.YACHT).map((categoryId) => [
        categoryId,
        1,
      ]),
    ) as Scorecard;
    const rolled = rolledMatch();
    const finalTurn: PlayingMatch = {
      ...rolled,
      players: [
        { ...rolled.players[0], scorecard: allButYacht, timeoutCount: 0 },
        {
          ...rolled.players[1],
          scorecard: { ...allButYacht, [CATEGORY_ID.YACHT]: 0 },
          timeoutCount: 0,
        },
      ],
    };

    const finished = selectScoreCategory(finalTurn, {
      seatIndex: creatorIndex,
      turnId: turnId('turn-1'),
      receivedAt: epochMilliseconds(2_000),
      categoryId: CATEGORY_ID.YACHT,
      nextTurn: { id: turnId('unused'), startedAt: epochMilliseconds(2_100) },
    });

    expect(finished).toMatchObject({
      ok: true,
      changed: true,
      match: {
        status: 'finished',
        result: { reason: 'scoresCompleted', winnerSeatIndex: null },
      },
    });
  });

  test('finishes with the higher-score winner after both players use 12 turns', () => {
    const allButYacht = Object.fromEntries(
      CATEGORY_IDS.filter((categoryId) => categoryId !== CATEGORY_ID.YACHT).map((categoryId) => [
        categoryId,
        1,
      ]),
    ) as Scorecard;
    const rolled = rolledMatch();
    const finalTurn: PlayingMatch = {
      ...rolled,
      players: [
        { ...rolled.players[0], scorecard: allButYacht, timeoutCount: 0 },
        {
          ...rolled.players[1],
          scorecard: {
            ...allButYacht,
            [CATEGORY_ID.CHOICE]: 0,
            [CATEGORY_ID.YACHT]: 0,
          },
          timeoutCount: 0,
        },
      ],
    };

    const finished = selectScoreCategory(finalTurn, {
      seatIndex: creatorIndex,
      turnId: turnId('turn-1'),
      receivedAt: epochMilliseconds(2_000),
      categoryId: CATEGORY_ID.YACHT,
      nextTurn: { id: turnId('unused'), startedAt: epochMilliseconds(2_100) },
    });

    expect(finished).toMatchObject({
      ok: true,
      match: {
        status: 'finished',
        result: { reason: 'scoresCompleted', winnerSeatIndex: creatorIndex },
      },
    });
  });
});

describe('future turn command boundaries', () => {
  test.each(['roll', 'hold', 'score'] as const)(
    '%s uses receivedAt within the start-inclusive deadline-exclusive window',
    (action) => {
      const rolled = rolledMatch();
      const match: PlayingMatch = {
        ...rolled,
        currentTurn: {
          ...rolled.currentTurn,
          startedAt: epochMilliseconds(5_000),
          deadlineAt: epochMilliseconds(95_000),
        },
      };
      const execute = (receivedAt: number) => {
        const command = {
          seatIndex: creatorIndex,
          turnId: match.currentTurn.id,
          receivedAt: epochMilliseconds(receivedAt),
        };
        switch (action) {
          case 'roll':
            return planRoll(match, command);
          case 'hold':
            return setDieHeld(match, { ...command, slot: 0, isHeld: true });
          case 'score':
            return selectScoreCategory(match, {
              ...command,
              categoryId: CATEGORY_ID.CHOICE,
              nextTurn: { id: turnId('next'), startedAt: epochMilliseconds(96_000) },
            });
        }
      };
      expect(execute(4_999)).toMatchObject({ ok: false, code: 'TURN_NOT_STARTED' });
      expect(execute(5_000).ok).toBeTrue();
      expect(execute(94_999).ok).toBeTrue();
      expect(execute(95_000)).toMatchObject({ ok: false, code: MATCH_REJECTION_CODE.TURN_EXPIRED });
      expect(match).toEqual({
        ...rolled,
        currentTurn: {
          ...rolled.currentTurn,
          startedAt: epochMilliseconds(5_000),
          deadlineAt: epochMilliseconds(95_000),
        },
      });
    },
  );
});
