import { CATEGORY_IDS, turnsUsed } from '@repo/yacht-rules';
import { describe, expect, test } from 'bun:test';

import {
  applyRollResult,
  createMatch,
  type Match,
  type MatchDecision,
  type MatchTransition,
  planRoll,
  type PlayingMatch,
  type RollApplicationResult,
  type RollPlan,
  selectScoreCategory,
  turnId,
} from '@/rooms/domain/match';
import { epochMilliseconds } from '@/rooms/domain/time';

const creatorIndex = 0 as const;
const joinerIndex = 1 as const;

function unwrapDecision<T>(decision: MatchDecision<T>): T {
  if (!decision.ok) throw new Error(decision.code);
  return decision.value;
}

function unwrapTransition(transition: MatchTransition | RollApplicationResult): Match {
  if (!transition.ok) {
    throw new Error('code' in transition ? transition.code : transition.reason);
  }
  return transition.match;
}

describe('cross-module match invariants', () => {
  test('rejects an overflowing initial turn deadline with the constructor error', () => {
    expect(() =>
      createMatch({
        initialTurn: {
          id: turnId('turn-overflow'),
          startedAt: epochMilliseconds(Number.MAX_SAFE_INTEGER),
        },
      }),
    ).toThrow('EpochMilliseconds must be a non-negative safe integer');
  });

  test('alternates exactly 24 scored turns and finishes without retaining turn state', () => {
    let match: Match = createMatch({
      initialTurn: { id: turnId('turn-0'), startedAt: epochMilliseconds(1_000) },
    });
    const actors = [];

    for (let turnIndex = 0; turnIndex < 24; turnIndex += 1) {
      expect(match.status).toBe('playing');
      if (match.status !== 'playing') throw new Error('Match ended early');
      const activeMatch: PlayingMatch = match;
      const actor = activeMatch.currentTurn.seatIndex;
      actors.push(actor);
      const player = activeMatch.players[actor];
      if (player === undefined) throw new Error('Missing active player');
      const categoryId = CATEGORY_IDS[Object.keys(player.scorecard).length];
      if (categoryId === undefined) throw new Error('No category left');

      const plan: RollPlan = unwrapDecision(
        planRoll(activeMatch, {
          seatIndex: actor,
          turnId: activeMatch.currentTurn.id,
          receivedAt: epochMilliseconds(activeMatch.currentTurn.startedAt + 1),
        }),
      );
      const rolled = unwrapTransition(
        applyRollResult(activeMatch, {
          plan,
          facesBySlot: [
            { slot: 0, value: 1 },
            { slot: 1, value: 2 },
            { slot: 2, value: 3 },
            { slot: 3, value: 4 },
            { slot: 4, value: 5 },
          ],
        }),
      );
      if (rolled.status !== 'playing') throw new Error('Roll ended match');

      match = unwrapTransition(
        selectScoreCategory(rolled, {
          seatIndex: actor,
          turnId: rolled.currentTurn.id,
          receivedAt: epochMilliseconds(rolled.currentTurn.startedAt + 2),
          categoryId,
          nextTurn: {
            id: turnId(`turn-${turnIndex + 1}`),
            startedAt: epochMilliseconds(2_000 + turnIndex * 1_000),
          },
        }),
      );

      for (const matchPlayer of match.players) {
        expect(turnsUsed(matchPlayer)).toBeLessThanOrEqual(12);
      }
    }

    expect(actors).toEqual(
      Array.from({ length: 24 }, (_, index) => (index % 2 === 0 ? creatorIndex : joinerIndex)),
    );
    expect(match).toMatchObject({
      status: 'finished',
      result: { reason: 'scoresCompleted', winnerSeatIndex: null },
    });
    expect('currentTurn' in match).toBe(false);
    expect(match.players.map(turnsUsed)).toEqual([12, 12]);
  });
});
