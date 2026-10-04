import { countFilledCategories, type Scorecard } from './scorecard';

export type SeatIndex = 0 | 1;

export function turnsUsed(
  player: Readonly<{ scorecard: Scorecard; timeoutCount: number }>,
): number {
  return countFilledCategories(player.scorecard) + player.timeoutCount;
}
