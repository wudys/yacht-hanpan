import { GAME_COMMAND_TYPE, type GameCommand } from '@repo/game-protocol/socket';
import { type GameSnapshot } from '@repo/game-protocol/state';

type ScoreCommand = Extract<GameCommand, { type: typeof GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY }>;
type PlayingMatch = Extract<GameSnapshot['match'], { status: 'playing' }>;
type Scorecard = GameSnapshot['match']['players'][number]['scorecard'];

export type ScoreRecord = Readonly<{
  stateVersion: GameSnapshot['stateVersion'];
  completedTurnId: ScoreCommand['turnId'];
  seatIndex: PlayingMatch['currentTurn']['seatIndex'];
  categoryId: ScoreCommand['categoryId'];
  score: NonNullable<Scorecard[ScoreCommand['categoryId']]>;
}>;

/** Accepted snapshots from an eligible carrier must be consecutive to identify a fresh record. */
export function freshScoreRecord(previous: GameSnapshot, next: GameSnapshot): ScoreRecord | null {
  if (next.stateVersion !== previous.stateVersion + 1 || previous.match.status !== 'playing')
    return null;
  const { seatIndex, turnId } = previous.match.currentTurn;
  if (
    next.match.status === 'playing'
      ? !isNewOpponentTurn(previous.match, next.match)
      : next.match.result.reason !== 'scoresCompleted'
  ) {
    return null;
  }
  const opponentSeat = seatIndex === 0 ? 1 : 0;
  const before = previous.match.players;
  const after = next.match.players;
  if (
    before[0].timeoutCount !== after[0].timeoutCount ||
    before[1].timeoutCount !== after[1].timeoutCount ||
    !sameScorecard(before[opponentSeat].scorecard, after[opponentSeat].scorecard)
  ) {
    return null;
  }
  const oldCard = before[seatIndex].scorecard;
  const newCard = after[seatIndex].scorecard;
  const oldKeys = categoryKeys(oldCard);
  const addedKeys = categoryKeys(newCard).filter((key) => !Object.hasOwn(oldCard, key));
  if (
    addedKeys.length !== 1 ||
    oldKeys.some((key) => !Object.hasOwn(newCard, key) || oldCard[key] !== newCard[key])
  ) {
    return null;
  }
  const categoryId = addedKeys[0]!;
  const score = newCard[categoryId];
  if (score === undefined) return null;
  return { stateVersion: next.stateVersion, completedTurnId: turnId, seatIndex, categoryId, score };
}

/** Accepted snapshots must be consecutive to identify a fresh active-seat timeout turn. */
export function isFreshTimeoutTurn(previous: GameSnapshot, next: GameSnapshot): boolean {
  if (
    next.stateVersion !== previous.stateVersion + 1 ||
    previous.match.status !== 'playing' ||
    next.match.status !== 'playing' ||
    !isNewOpponentTurn(previous.match, next.match)
  ) {
    return false;
  }
  const activeSeat = previous.match.currentTurn.seatIndex;
  const opponentSeat = activeSeat === 0 ? 1 : 0;
  const before = previous.match.players;
  const after = next.match.players;
  return (
    after[activeSeat].timeoutCount === before[activeSeat].timeoutCount + 1 &&
    after[opponentSeat].timeoutCount === before[opponentSeat].timeoutCount &&
    sameScorecard(before[0].scorecard, after[0].scorecard) &&
    sameScorecard(before[1].scorecard, after[1].scorecard)
  );
}

function isNewOpponentTurn(previous: PlayingMatch, next: PlayingMatch): boolean {
  return (
    next.currentTurn.turnId !== previous.currentTurn.turnId &&
    next.currentTurn.seatIndex !== previous.currentTurn.seatIndex &&
    next.currentTurn.rollCount === 0
  );
}

function categoryKeys(card: Scorecard): ScoreCommand['categoryId'][] {
  return Object.keys(card) as ScoreCommand['categoryId'][];
}

function sameScorecard(previous: Scorecard, next: Scorecard): boolean {
  const keys = categoryKeys(previous);
  return (
    keys.length === categoryKeys(next).length &&
    keys.every((key) => Object.hasOwn(next, key) && previous[key] === next[key])
  );
}
