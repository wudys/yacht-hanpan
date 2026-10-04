import { describe, expect, test } from 'bun:test';

import { sampleRolls } from './sample-rolls';

const ROLL_COUNT = 400;

describe('extended dice distribution', () => {
  test('stays within broad fairness diagnostics without discarding any seed', async () => {
    const samples = await sampleRolls(ROLL_COUNT, 'statistical');
    const expectedPerFace = samples.length / 6;
    const faceCounts = [1, 2, 3, 4, 5, 6].map(
      (face) => samples.filter((sample) => sample.face === face).length,
    );
    const chiSquare = faceCounts.reduce(
      (sum, observed) => sum + (observed - expectedPerFace) ** 2 / expectedPerFace,
      0,
    );
    const faces = samples.map((sample) => sample.face);
    const serialCorrelation = correlation(faces.slice(0, -1), faces.slice(1));
    const leftMean = mean(
      samples.filter((sample) => sample.finalX < 0).map((sample) => sample.face),
    );
    const rightMean = mean(
      samples.filter((sample) => sample.finalX > 0).map((sample) => sample.face),
    );

    expect(samples).toHaveLength(ROLL_COUNT * 5);
    expect(chiSquare).toBeLessThan(20.52);
    expect(Math.abs(serialCorrelation)).toBeLessThan(0.1);
    expect(Math.abs(leftMean - rightMean)).toBeLessThan(0.35);
  });
});

function correlation(left: readonly number[], right: readonly number[]): number {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  return numerator / Math.sqrt(leftVariance * rightVariance);
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
