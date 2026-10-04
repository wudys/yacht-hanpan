import { expect, test } from 'bun:test';

import { AUTOMATIC_POUR_STYLES } from '../../contract';
import { createCupMotion, cupTransformAt } from './cup-motion';

test('supports the selected classic, burst and oblique styles', () => {
  expect(AUTOMATIC_POUR_STYLES).toEqual(['classic', 'burst', 'oblique']);
});

test('keeps classic shaking separate from the later pour', () => {
  const motion = createCupMotion('gesture-explore-20260921-0', 'classic');
  const poured = cupTransformAt(
    motion,
    motion.pourAtMs +
      Math.max(motion.pourDurationMs, motion.pourTravelDelayMs + motion.pourTravelDurationMs),
  );
  expect(poured.x).toBeCloseTo(motion.releaseX, 8);
  expect(poured.tilt).toBeCloseTo(motion.tilt, 8);
  // At 500ms the selected shake still moves independently of the later pour.
  const pose = cupTransformAt(motion, 500);
  expect(Math.abs(pose.x - motion.stageX)).toBeGreaterThan(0.12);
  expect(Math.abs(pose.tilt)).toBeGreaterThan(0.18);
  expect(cupTransformAt(motion, motion.pourAtMs - 80)).toEqual(
    cupTransformAt(motion, motion.pourAtMs),
  );
});

test('joins shaking to pouring with continuous position, tilt and velocity', () => {
  for (const seed of ['gesture-explore-20260921-0', 'gesture-explore-20260921-1']) {
    const motion = createCupMotion(seed, 'classic');
    const center = cupTransformAt(motion, motion.pourAtMs);
    const before = cupTransformAt(motion, motion.pourAtMs - 0.01);
    const after = cupTransformAt(motion, motion.pourAtMs + 0.01);
    for (const key of ['x', 'y', 'z', 'tilt'] as const) {
      expect(Math.abs((after[key] - center[key]) / 0.01)).toBeLessThan(0.0001);
      expect(Math.abs((center[key] - before[key]) / 0.01)).toBeLessThan(0.0001);
    }
  }
});

test.each(['classic', 'burst', 'oblique'] as const)(
  'pours %s without a vertical velocity reversal or a sharp acceleration spike',
  (style) => {
    for (const seed of ['gesture-explore-20260921-0', 'gesture-explore-20260921-1']) {
      const motion = createCupMotion(seed, style);
      const height = (offset: number) => cupTransformAt(motion, motion.pourAtMs + offset).y;
      // One millisecond probes the trajectory itself, independently of physics substeps.
      // Keep vertical acceleration below gravity: this is a gentle lift, not a throw.
      for (let ms = 0; ms <= motion.pourDurationMs; ms += 1) {
        const before = height(ms - 1);
        const current = height(ms);
        const after = height(ms + 1);
        expect(after - current).toBeGreaterThanOrEqual(-1e-10);
        expect(Math.abs((after - 2 * current + before) * 1_000_000)).toBeLessThan(27.2);
      }
      expect(
        Math.abs((height(motion.pourDurationMs) - height(motion.pourDurationMs - 1)) * 1000),
      ).toBeLessThan(0.001);
    }
  },
);
