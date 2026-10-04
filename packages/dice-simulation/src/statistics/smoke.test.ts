import { describe, expect, test } from 'bun:test';

import { sampleRolls } from './sample-rolls';

describe('dice distribution smoke', () => {
  test('covers every face without broad slot or spatial collapse', async () => {
    const samples = await sampleRolls(48, 'smoke');
    const faceCounts = [1, 2, 3, 4, 5, 6].map(
      (face) => samples.filter((sample) => sample.face === face).length,
    );
    const slotMeans = [0, 1, 2, 3, 4].map((slot) => {
      const faces = samples.filter((sample) => sample.slot === slot).map((sample) => sample.face);
      return mean(faces);
    });
    const left = samples.filter((sample) => sample.finalX < 0).length;
    const right = samples.filter((sample) => sample.finalX > 0).length;

    expect(samples).toHaveLength(240);
    expect(Math.min(...faceCounts)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...slotMeans) - Math.min(...slotMeans)).toBeLessThan(1.2);
    expect(left / samples.length).toBeGreaterThan(0.25);
    expect(right / samples.length).toBeGreaterThan(0.25);
  });
});

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
