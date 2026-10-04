import { describe, expect, it } from 'bun:test';

import { interpolateMotionCap, limitPlanarVelocity } from './rollout-motion';

describe('rollout motion assistance', () => {
  it('limits planar velocity without changing its heading', () => {
    const limited = limitPlanarVelocity({ x: 6, z: 2 }, { maxX: 4, maxZ: 3 });
    const cross = 6 * limited.z - 2 * limited.x;

    expect(limited).toEqual({ x: 4, z: 4 / 3 });
    expect(Math.abs(cross)).toBeLessThan(1e-9);
  });

  it('interpolates motion caps continuously across tuning points', () => {
    const points = [
      { t: 0, value: 5.9 },
      { t: 0.45, value: 4.9 },
      { t: 1.1, value: 3.5 },
    ];

    expect(
      Math.abs(
        interpolateMotionCap(0.45 - 1e-5, points) - interpolateMotionCap(0.45 + 1e-5, points),
      ),
    ).toBeLessThan(0.001);
  });
});
