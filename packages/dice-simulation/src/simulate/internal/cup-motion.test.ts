import { describe, expect, it, test } from 'bun:test';

import {
  AUTOMATIC_POUR_STYLES,
  CUP_EXIT_HOLD_MS,
  cupLowerSupport,
  DEFAULT_CUP_GEOMETRY,
  DIE_GEOMETRY,
  POUR_STYLES,
  TRAY_FLOOR_TOP_Y,
  TRAY_GEOMETRY,
} from '../../contract';
import { createCupFrame, createCupMotion, cupTransformAt, quatFromEuler } from './cup-motion';
import { CUP_GATHER_MS } from './cup-motion-progress';
import { rotateVectorByQuat } from './result-recognition';
import { rollAreaMeta } from './roll-simulation-constants';

// Six side/yaw combinations plus both preparation-time boundaries; count is not a motion input.
const motionCases = [
  { seed: 'motion-coverage-0', side: 1, yawDegrees: 6 },
  { seed: 'motion-coverage-1', side: -1, yawDegrees: -6 },
  { seed: 'motion-coverage-2', side: 1, yawDegrees: -6 },
  { seed: 'motion-coverage-4', side: 1, yawDegrees: 0 },
  { seed: 'motion-coverage-7', side: -1, yawDegrees: 6 },
  { seed: 'motion-coverage-13', side: -1, yawDegrees: 0 },
  { seed: 'motion-coverage-58', side: 1, yawDegrees: -6, preparationMs: 930 },
  { seed: 'motion-coverage-102', side: 1, yawDegrees: -6, preparationMs: 780 },
];
const seeds = motionCases.map(({ seed }) => seed);

describe('cup motion', () => {
  it.each(POUR_STYLES)(
    'varies %s preparation by seed within its rhythm without changing strength',
    (style) => {
      const durations = seeds.map((seed) => {
        const motion = createCupMotion(seed, style);
        expect(motion).toEqual(createCupMotion(seed, style));
        expect(motion.pourAtMs).toBeGreaterThanOrEqual(780);
        expect(motion.pourAtMs).toBeLessThanOrEqual(930);
        expect(motion.shakeAmplitude).toBe(1);
        expect(motion.shakeFrequency).toBe(24);
        expect(createCupFrame(motion, motion.pourAtMs - 1).mode).toBe('shake');
        expect(createCupFrame(motion, motion.pourAtMs).mode).toBe('pour');
        return motion.pourAtMs;
      });
      expect(new Set(durations).size).toBeGreaterThan(1);
    },
  );

  it('shares the selected preparation rhythm across pour styles', () => {
    for (const seed of seeds) {
      const classic = createCupMotion(seed, 'classic').pourAtMs;
      expect(createCupMotion(seed, 'burst').pourAtMs).toBe(classic);
      expect(createCupMotion(seed, 'oblique').pourAtMs).toBe(classic);
    }
  });

  it.each(POUR_STYLES.flatMap((style) => motionCases.map((fixture) => ({ ...fixture, style }))))(
    'keeps $seed ($style) in its intended branch with a continuous full-shell fit',
    ({ seed, side, yawDegrees, style, preparationMs }) => {
      const motion = createCupMotion(seed, style);
      expect(Math.sign(motion.stageX)).toBe(side);
      expect(Math.sign(motion.tilt)).toBe(side);
      // Burst uses the same side selection but its pour always has zero yaw.
      expect(motion.pourYaw).toBeCloseTo(
        ((style === 'burst' ? 0 : yawDegrees) * Math.PI) / 180,
        10,
      );
      expect(cupTransformAt(motion, motion.pourAtMs).yaw).toBeCloseTo(0, 10);
      expect(cupTransformAt(motion, motion.pourAtMs + motion.pourDurationMs).yaw).toBeCloseTo(
        ((style === 'burst' ? 0 : yawDegrees) * Math.PI) / 180,
        10,
      );
      if (preparationMs !== undefined) expect(motion.pourAtMs).toBe(preparationMs);
      const transitions = [
        motion.pourAtMs - CUP_GATHER_MS,
        motion.pourAtMs,
        ...(style === 'burst' ? [motion.pourAtMs + 260] : []),
        motion.pourAtMs + 280,
        motion.pourAtMs + motion.pourDurationMs,
        motion.pourAtMs + motion.pourTravelDelayMs + motion.pourTravelDurationMs,
        motion.releaseAtMs,
        motion.releaseAtMs + CUP_EXIT_HOLD_MS,
        motion.exitAtMs,
      ];
      const times = new Set<number>([0]);
      for (let time = 0; time <= motion.exitAtMs; time += 16) times.add(time);
      for (const time of transitions) {
        times.add(time - 0.001);
        times.add(time);
        times.add(time + 0.001);
        const before = cupTransformAt(motion, time - 0.001);
        const after = cupTransformAt(motion, time + 0.001);
        expect(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)).toBeLessThan(
          0.0001,
        );
        expect(Math.abs(after.tilt - before.tilt)).toBeLessThan(0.0001);
        expect(Math.abs(after.yaw - before.yaw)).toBeLessThan(0.0001);
      }
      const area = rollAreaMeta();
      const radius = DEFAULT_CUP_GEOMETRY.innerRadius + DEFAULT_CUP_GEOMETRY.wallThickness;
      const halfHeight = DEFAULT_CUP_GEOMETRY.innerHeight / 2 + DEFAULT_CUP_GEOMETRY.baseThickness;
      for (const time of [...times].sort((a, b) => a - b)) {
        const p = cupTransformAt(motion, time);
        // Leave two die edges below the complete shell, including its shake sweep.
        expect(p.y - cupLowerSupport(p.tilt) - TRAY_FLOOR_TOP_Y).toBeGreaterThan(
          DIE_GEOMETRY.size * 2,
        );
        expect(p.y + cupLowerSupport(p.tilt + Math.PI)).toBeLessThan(
          TRAY_GEOMETRY.ceilingY - TRAY_GEOMETRY.ceilingHalfHeight,
        );
        const axis = rotateVectorByQuat([0, 1, 0], quatFromEuler(0, p.yaw, p.tilt));
        const halfWidth =
          radius * Math.sqrt(Math.max(0, 1 - axis[0] ** 2)) + halfHeight * Math.abs(axis[0]);
        const halfDepth =
          radius * Math.sqrt(Math.max(0, 1 - axis[2] ** 2)) + halfHeight * Math.abs(axis[2]);
        expect(p.x - halfWidth).toBeGreaterThan(-TRAY_GEOMETRY.halfWidth);
        expect(p.x + halfWidth).toBeLessThan(TRAY_GEOMETRY.halfWidth);
        expect(p.z - halfDepth).toBeGreaterThanOrEqual((area.topZ ?? 0) - 0.001);
        expect(p.z + halfDepth).toBeLessThanOrEqual((area.bottomZ ?? area.depth) + 0.001);
      }
    },
  );

  it.each(POUR_STYLES)('preserves the selected %s lift and minimum floor gap', (style) => {
    const motion = createCupMotion('browser-parity-v1', style);
    const start = cupTransformAt(motion, motion.pourAtMs);
    let minimumGap = Infinity;
    for (let ms = 0; ms <= 400; ms += 1) {
      const pose = cupTransformAt(motion, motion.pourAtMs + ms);
      minimumGap = Math.min(minimumGap, pose.y - cupLowerSupport(pose.tilt) - TRAY_FLOOR_TOP_Y);
    }
    expect(minimumGap / DIE_GEOMETRY.size).toBeCloseTo(
      style === 'classic' ? 2.28 : style === 'burst' ? 2.848 : 2.865,
      2,
    );
    const lifted = cupTransformAt(motion, motion.pourAtMs + 280);
    expect((lifted.y - start.y) / DIE_GEOMETRY.size).toBeCloseTo(0.55, 2);
    expect(cupTransformAt(motion, motion.pourAtMs + 400).y).toBeCloseTo(lifted.y, 10);
    expect(
      (Math.abs(cupTransformAt(motion, motion.pourAtMs + 400).tilt) * 180) / Math.PI,
    ).toBeCloseTo(style === 'classic' ? 155 : 145, 8);
  });

  it('finishes burst in two gentle stages without speeding up the final tip', () => {
    const motion = createCupMotion('browser-parity-v1', 'burst');
    const angle = (ms: number) => Math.abs(cupTransformAt(motion, motion.pourAtMs + ms).tilt);
    expect((angle(260) * 180) / Math.PI).toBeCloseTo(120, 8);
    expect((angle(400) * 180) / Math.PI).toBeCloseTo(145, 8);
    expect(Math.abs((angle(260.01) - angle(259.99)) / 0.02)).toBeLessThan(0.00001);
  });

  describe('selected pour gestures', () => {
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
  });
});
