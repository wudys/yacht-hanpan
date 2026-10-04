import {
  type GameSnapshot,
  type GameSnapshotInput,
  MATCH_END_REASON,
  parseGameSnapshot,
} from '@repo/game-protocol/socket';

import type { Match, MatchDie, MatchPlayer, MatchTurn } from '@/rooms/domain/match';

type ProjectedTurn = Extract<GameSnapshotInput['match'], { status: 'playing' }>['currentTurn'];
type ProjectedDie = Extract<ProjectedTurn, { rollCount: 1 | 2 | 3 }>['dice'][number];

function projectPlayer(player: MatchPlayer): GameSnapshotInput['match']['players'][number] {
  return {
    scorecard: { ...player.scorecard },
    timeoutCount: player.timeoutCount,
  };
}

function projectDie(die: MatchDie): ProjectedDie {
  return { value: die.value };
}

function projectTurn(turn: MatchTurn): ProjectedTurn {
  const identity = {
    turnId: turn.id,
    seatIndex: turn.seatIndex,
    startedAt: turn.startedAt,
    deadlineAt: turn.deadlineAt,
  };
  if (turn.diceState.rollCount === 0) {
    if (turn.heldSlots.length !== 0) throw new Error('Unrolled turn cannot contain held dice');
    return { ...identity, heldSlots: [], rollCount: 0, dice: null };
  }
  const { dice } = turn.diceState;
  return {
    ...identity,
    heldSlots: [...turn.heldSlots],
    rollCount: turn.diceState.rollCount,
    dice: [
      projectDie(dice[0]),
      projectDie(dice[1]),
      projectDie(dice[2]),
      projectDie(dice[3]),
      projectDie(dice[4]),
    ],
  };
}

function projectResult(
  result: Extract<Match, { status: 'finished' }>['result'],
): Extract<GameSnapshotInput['match'], { status: 'finished' }>['result'] {
  // Only completed scores allow a draw; retain that relation in the projected union.
  if (result.reason === MATCH_END_REASON.SCORES_COMPLETED) {
    return { reason: result.reason, winnerSeatIndex: result.winnerSeatIndex };
  }
  return { reason: result.reason, winnerSeatIndex: result.winnerSeatIndex };
}

export function projectGameSnapshot(match: Match, stateVersion: number): GameSnapshot {
  const players: GameSnapshotInput['match']['players'] = [
    projectPlayer(match.players[0]),
    projectPlayer(match.players[1]),
  ];
  const projectedMatch: GameSnapshotInput['match'] =
    match.status === 'playing'
      ? { status: match.status, players, currentTurn: projectTurn(match.currentTurn) }
      : {
          status: match.status,
          players,
          result: projectResult(match.result),
        };
  return parseGameSnapshot({ stateVersion, match: projectedMatch } satisfies GameSnapshotInput);
}
