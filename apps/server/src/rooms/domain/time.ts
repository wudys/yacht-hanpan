export type EpochMilliseconds = number & {
  readonly __brand: 'EpochMilliseconds';
};

export function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function epochMilliseconds(value: number): EpochMilliseconds {
  if (!isValidTimestamp(value)) {
    throw new Error('EpochMilliseconds must be a non-negative safe integer');
  }
  return value as EpochMilliseconds;
}
