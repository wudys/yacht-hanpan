import { describe, expect, test } from 'bun:test';

import { sampleRolls } from './sample-rolls';

describe('dice distribution smoke', () => {
  test('covers every face without broad slot or spatial collapse', async () => {
    const groups = await sampleRolls(12, 'smoke');
    const samples = groups.flatMap((group) => group.samples);
    const faceCounts = [1, 2, 3, 4, 5, 6].map(
      (face) => samples.filter((sample) => sample.face === face).length,
    );
    const slotMeans = [0, 1, 2, 3, 4].map((slot) => {
      const faces = samples.filter((sample) => sample.slot === slot).map((sample) => sample.face);
      return mean(faces);
    });
    const left = samples.filter((sample) => sample.finalX < 0).length;
    const right = samples.filter((sample) => sample.finalX > 0).length;

    expect(groups.reduce((sum, group) => sum + group.attempted, 0)).toBe(120);
    for (const group of groups) {
      expect(group.accepted + group.rejected.length).toBe(group.attempted);
      expect(group.samples).toHaveLength(group.accepted * group.count);
    }
    expect(Math.min(...faceCounts)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...slotMeans) - Math.min(...slotMeans)).toBeLessThan(1.2);
    expect(left / samples.length).toBeGreaterThan(0.25);
    expect(right / samples.length).toBeGreaterThan(0.25);
  });
});

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
