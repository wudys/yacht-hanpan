import { describe, expect, it } from 'bun:test';

import {
  cupLowerSupport,
  DEFAULT_CUP_GEOMETRY,
  DIE_GEOMETRY,
  POUR_STYLES,
  TRAY_FLOOR_TOP_Y,
  TRAY_GEOMETRY,
} from '../../contract';
import { createCupFrame, createCupMotion, cupTransformAt, quatFromEuler } from './cup-motion';
import { createCupPourProfile } from './cup-pour-profile';
import { rotateVectorByQuat } from './result-recognition';
import { rollAreaMeta } from './roll-simulation-constants';

const seeds = ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e', 'seed-f', 'seed-g', 'seed-h'];

describe('cup pour profile', () => {
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

  it.each(POUR_STYLES)(
    'keeps the entire %s cup sweep inside the same tray and below the ceiling',
    (style) => {
      for (const seed of seeds) {
        const motion = createCupMotion(seed, style);
        for (let time = 0; time <= motion.exitAtMs; time += 16) {
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
            (DEFAULT_CUP_GEOMETRY.innerRadius + DEFAULT_CUP_GEOMETRY.wallThickness) *
              Math.sqrt(Math.max(0, 1 - axis[0] ** 2)) +
            (DEFAULT_CUP_GEOMETRY.innerHeight / 2 + DEFAULT_CUP_GEOMETRY.baseThickness) *
              Math.abs(axis[0]);
          expect(p.x - halfWidth).toBeGreaterThan(-TRAY_GEOMETRY.halfWidth);
          expect(p.x + halfWidth).toBeLessThan(TRAY_GEOMETRY.halfWidth);
        }
      }
    },
  );

  it('shares seeded 0/±6° yaw between classic and oblique while burst stays straight', () => {
    for (const [seed, degrees] of [
      ['browser-parity-v1', 0],
      ['coherent-pour-baseline-5-4', 6],
      ['pour-direction-1', -6],
    ] as const) {
      for (const style of POUR_STYLES) {
        const motion = createCupMotion(seed, style);
        expect(cupTransformAt(motion, motion.pourAtMs).yaw).toBeCloseTo(0, 10);
        expect(cupTransformAt(motion, motion.pourAtMs + 400).yaw).toBeCloseTo(
          ((style === 'burst' ? 0 : degrees) * Math.PI) / 180,
          10,
        );
      }
    }
  });

  it.each(POUR_STYLES)('preserves the selected %s lift and minimum floor gap', (style) => {
    const motion = createCupMotion('browser-parity-v1', style);
    const start = cupTransformAt(motion, motion.pourAtMs);
    let minimumGap = Infinity;
    for (let ms = 0; ms <= 400; ms += 1) {
      const pose = cupTransformAt(motion, motion.pourAtMs + ms);
      minimumGap = Math.min(minimumGap, pose.y - cupLowerSupport(pose.tilt) - TRAY_FLOOR_TOP_Y);
    }
    expect(minimumGap / DIE_GEOMETRY.size).toBeCloseTo(
      style === 'classic' ? 2.273 : style === 'burst' ? 2.84 : 2.859,
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

  it.each(POUR_STYLES)('keeps %s cup position and tilt continuous as pouring starts', (style) => {
    let positionJump = 0;
    let tiltJump = 0;
    for (const seed of seeds) {
      const motion = createCupMotion(seed, style);
      const before = cupTransformAt(motion, motion.pourAtMs - 0.001);
      const after = cupTransformAt(motion, motion.pourAtMs);
      positionJump = Math.max(
        positionJump,
        Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z),
      );
      tiltJump = Math.max(tiltJump, Math.abs(after.tilt - before.tilt));
    }
    expect(positionJump).toBeLessThan(0.0001);
    expect(tiltJump).toBeLessThan(0.0001);
  });

  it('keeps the enlarged shell and shake sweep below the rack and above the lower edge', () => {
    const area = rollAreaMeta();
    const shellHalfDepth = DEFAULT_CUP_GEOMETRY.innerRadius + DEFAULT_CUP_GEOMETRY.wallThickness;
    let intrusion = 0;
    for (const style of POUR_STYLES) {
      for (let count = 1; count <= 5; count += 1) {
        for (let sequence = 0; sequence < 50; sequence += 1) {
          const motion = createCupMotion(
            `dice-quality-tuning-${style}-${count}-${sequence}`,
            style,
          );
          for (let time = 0; time <= motion.exitAtMs; time += 16) {
            const { z, yaw, tilt } = cupTransformAt(motion, time);
            const axis = rotateVectorByQuat([0, 1, 0], quatFromEuler(0, yaw, tilt));
            const halfDepth =
              shellHalfDepth * Math.sqrt(Math.max(0, 1 - axis[2] ** 2)) +
              (DEFAULT_CUP_GEOMETRY.innerHeight / 2 + DEFAULT_CUP_GEOMETRY.baseThickness) *
                Math.abs(axis[2]);
            intrusion = Math.max(
              intrusion,
              (area.topZ ?? 0) - z + halfDepth,
              z + halfDepth - (area.bottomZ ?? area.depth),
            );
          }
        }
      }
    }
    expect(intrusion).toBeLessThanOrEqual(0.001);
  });

  it('uses both seeded cup sides with stable release and tilt toward the center', () => {
    const area = rollAreaMeta();
    const sides = seeds.map((seed) => {
      const profile = createCupPourProfile(seed, area);
      expect(profile).toEqual(createCupPourProfile(seed, area));
      expect(Math.sign(profile.releaseX)).toBe(Math.sign(profile.stageX));
      expect(Math.sign(profile.tilt)).toBe(Math.sign(profile.stageX));
      expect(Math.abs(profile.releaseX)).toBeLessThan(Math.abs(profile.stageX));
      return Math.sign(profile.stageX);
    });

    expect(new Set(sides)).toEqual(new Set([-1, 1]));
  });
});
