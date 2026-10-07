import { describe, expect, test } from 'bun:test';

import { sampleCorrelations } from './sample-correlations';
import { sampleRolls } from './sample-rolls';

const ROLLS_PER_GROUP = 400;

describe('extended dice distribution', () => {
  test('retains every first-candidate denominator and audits accepted distribution/coupling', async () => {
    const groups = await sampleRolls(ROLLS_PER_GROUP, 'statistical');
    const samples = groups.flatMap((group) => group.samples);
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

    expect(groups).toHaveLength(10);
    for (const group of groups) {
      expect(group.attempted).toBe(ROLLS_PER_GROUP);
      expect(group.accepted + group.rejected.length).toBe(group.attempted);
      expect(group.samples).toHaveLength(group.accepted * group.count);
    }
    expect(chiSquare).toBeLessThan(20.52);
    for (const group of groups.filter(({ count }) => count === 5)) {
      // This axis measures adjacent accepted candidates, not neighbours in the
      // raw attempted stream. The original coordinates/rejections remain above.
      const sequences = [...new Set(group.samples.map((sample) => sample.sequence))];
      const acceptedIndex = new Map(sequences.map((sequence, index) => [sequence, index]));
      const acceptedSamples = group.samples.map((sample) => ({
        ...sample,
        sequence: acceptedIndex.get(sample.sequence)!,
      }));
      const { temporal, withinRoll } = sampleCorrelations(acceptedSamples, group.accepted);
      // At about400 accepted pairs,0.2 is a broad coupling alarm, not certification.
      for (const { slot, pairCount, correlation } of temporal) {
        expect(
          Math.abs(correlation),
          `${group.pourStyle} temporal slot ${slot}, ${pairCount} pairs, r=${correlation}`,
        ).toBeLessThan(0.2);
      }
      for (const { slots, pairCount, correlation } of withinRoll) {
        expect(
          Math.abs(correlation),
          `${group.pourStyle} within-roll slots ${slots.join('/')}, ${pairCount} pairs, r=${correlation}`,
        ).toBeLessThan(0.2);
      }
    }
    expect(Math.abs(leftMean - rightMean)).toBeLessThan(0.35);
  });
});

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
