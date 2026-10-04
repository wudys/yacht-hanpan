import { MAX_ROLLS_PER_TURN, type Scorecard } from '@repo/yacht-rules';

import {
  deriveGameViewModel,
  type GameViewInput,
  type GameViewModel,
} from '@/features/game/view/game-view-model';

// Development-only, rule-consistent presentation data. Never a transport fallback.
const players = [
  { scorecard: { ones: 3, fives: 10, 'full-house': 18 }, timeoutCount: 0 },
  { scorecard: { ones: 2, twos: 6, choice: 21 }, timeoutCount: 0 },
] as const;
const achievementPlayers = [
  { scorecard: { ones: 3, fives: 10 }, timeoutCount: 0 },
  { scorecard: { ones: 2, twos: 6, choice: 21 }, timeoutCount: 0 },
] as const;
const bonusEarnedPlayers = [
  {
    scorecard: { ones: 4, twos: 8, threes: 12, fours: 16, fives: 20, sixes: 24 },
    timeoutCount: 0,
  },
  players[1],
] as const;

type FixtureResultMode = 'win' | 'loss' | 'draw' | 'forfeit' | 'timeout' | 'connection-ended';
type FixtureResultOutcome = 'viewer-win' | 'opponent-win' | 'draw';
type FixtureResultReason = 'normal' | 'forfeit' | 'timeout' | 'connection-ended';
type FixturePlayer = Readonly<{ scorecard: Scorecard; timeoutCount: 0 | 1 | 2 | 3 }>;

export type FixtureResult = Readonly<{
  model: GameViewModel;
  outcome: FixtureResultOutcome;
  reason: FixtureResultReason;
}>;

const COMPLETE_HIGH: Scorecard = {
  ones: 3,
  twos: 6,
  threes: 9,
  fours: 16,
  fives: 20,
  sixes: 24,
  choice: 27,
  'four-of-a-kind': 26,
  'full-house': 28,
  'small-straight': 15,
  'large-straight': 30,
  yacht: 50,
};
const COMPLETE_LOW: Scorecard = {
  ones: 2,
  twos: 8,
  threes: 12,
  fours: 12,
  fives: 15,
  sixes: 18,
  choice: 24,
  'four-of-a-kind': 20,
  'full-house': 0,
  'small-straight': 15,
  'large-straight': 30,
  yacht: 0,
};
const PARTIAL_LOW: Scorecard = { ones: 3, twos: 6, 'full-house': 0 };
const PARTIAL_HIGH: Scorecard = { ones: 2, twos: 4, choice: 21 };

export function createFixtureGame(mode: string) {
  const achievedFace = mode === 'yacht' ? 5 : mode === 'other' ? 4 : null;
  const snapshot: GameViewInput = {
    match: {
      status: 'playing',
      players:
        mode === 'bonus-earned'
          ? bonusEarnedPlayers
          : achievedFace === null
            ? players
            : achievementPlayers,
      currentTurn: {
        seatIndex: mode === 'opponent' ? 1 : 0,
        rollCount: mode === 'before-roll' ? 0 : mode === 'final' ? MAX_ROLLS_PER_TURN : 1,
        heldSlots: mode === 'before-roll' ? [] : [0, 1],
        dice:
          mode === 'before-roll'
            ? null
            : [
                { value: 5 },
                { value: 5 },
                { value: achievedFace ?? 4 },
                { value: achievedFace ?? 2 },
                { value: achievedFace ?? 3 },
              ],
      },
    },
  };
  return deriveGameViewModel(snapshot, 0);
}

export function createFixtureResult(input: string): FixtureResult {
  const configuration = resultConfiguration(normalizeResultMode(input));
  const model = deriveGameViewModel(
    {
      match: { status: 'finished', players: configuration.players },
    },
    0,
  );
  return {
    model,
    outcome: configuration.outcome,
    reason: configuration.reason,
  };
}

function normalizeResultMode(input: string): FixtureResultMode {
  return input === 'loss' ||
    input === 'draw' ||
    input === 'forfeit' ||
    input === 'timeout' ||
    input === 'connection-ended'
    ? input
    : 'win';
}

function resultConfiguration(mode: FixtureResultMode): Readonly<{
  players: readonly [FixturePlayer, FixturePlayer];
  outcome: FixtureResultOutcome;
  reason: FixtureResultReason;
}> {
  switch (mode) {
    case 'loss':
      return {
        players: [player(COMPLETE_LOW), player(COMPLETE_HIGH)],
        outcome: 'opponent-win',
        reason: 'normal',
      };
    case 'draw':
      return {
        players: [player(COMPLETE_HIGH), player(COMPLETE_HIGH)],
        outcome: 'draw',
        reason: 'normal',
      };
    case 'forfeit':
      return {
        players: [player(PARTIAL_LOW), player(PARTIAL_HIGH)],
        outcome: 'opponent-win',
        reason: 'forfeit',
      };
    case 'timeout':
      return {
        players: [player(PARTIAL_LOW, 3), player(PARTIAL_HIGH)],
        outcome: 'opponent-win',
        reason: 'timeout',
      };
    case 'connection-ended':
      return {
        players: [player(PARTIAL_HIGH), player(PARTIAL_LOW)],
        outcome: 'viewer-win',
        reason: 'connection-ended',
      };
    case 'win':
      return {
        players: [player(COMPLETE_HIGH), player(COMPLETE_LOW)],
        outcome: 'viewer-win',
        reason: 'normal',
      };
  }
}

function player(scorecard: Scorecard, timeoutCount: 0 | 1 | 2 | 3 = 0): FixturePlayer {
  return { scorecard, timeoutCount };
}
