export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
export type DieSlot = 0 | 1 | 2 | 3 | 4;

export type Dice = readonly [DieFace, DieFace, DieFace, DieFace, DieFace];

export function isDieFace(value: unknown): value is DieFace {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6;
}
