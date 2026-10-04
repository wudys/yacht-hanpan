export type EpochMilliseconds = number & {
  readonly __brand: 'EpochMilliseconds';
};

export function epochMilliseconds(value: number): EpochMilliseconds {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('EpochMilliseconds must be a non-negative safe integer');
  }
  return value as EpochMilliseconds;
}
