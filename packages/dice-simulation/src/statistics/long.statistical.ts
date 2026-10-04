import { describe, expect, test } from 'bun:test';

import { sampleCorrelations } from './sample-correlations';
import { sampleRolls } from './sample-rolls';

const ROLL_COUNT = 400;

describe('extended dice distribution', () => {
  test('stays within broad distribution and coupling diagnostics without discarding any seed', async () => {
    const samples = await sampleRolls(ROLL_COUNT, 'statistical');
    const { temporal, withinRoll } = sampleCorrelations(samples, ROLL_COUNT);
    const expectedPerFace = samples.length / 6;
    const faceCounts = [1, 2, 3, 4, 5, 6].map(
      (face) => samples.filter((sample) => sample.face === face).length,
    );
    const chiSquare = faceCounts.reduce(
      (sum, observed) => sum + (observed - expectedPerFace) ** 2 / expectedPerFace,
      0,
    );
    const leftMean = mean(
      samples.filter((sample) => sample.finalX < 0).map((sample) => sample.face),
    );
    const rightMean = mean(
      samples.filter((sample) => sample.finalX > 0).map((sample) => sample.face),
    );

    expect(samples).toHaveLength(ROLL_COUNT * 5);
    expect(chiSquare).toBeLessThan(20.52);
    // At 399/400 pairs, 0.2 is roughly 4/sqrt(n): a broad coupling alarm, not certification.
    for (const { slot, pairCount, correlation } of temporal) {
      expect(
        Math.abs(correlation),
        `temporal slot ${slot}, ${pairCount} pairs, r=${correlation}`,
      ).toBeLessThan(0.2);
    }
    for (const { slots, pairCount, correlation } of withinRoll) {
      expect(
        Math.abs(correlation),
        `within-roll slots ${slots.join('/')}, ${pairCount} pairs, r=${correlation}`,
      ).toBeLessThan(0.2);
    }
    expect(Math.abs(leftMean - rightMean)).toBeLessThan(0.35);
  });
});

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
