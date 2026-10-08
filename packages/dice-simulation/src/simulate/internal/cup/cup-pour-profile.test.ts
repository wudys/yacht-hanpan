import { describe, expect, it } from 'bun:test';

import { rollAreaMeta } from '../roll-simulation-constants';
import { createCupPourProfile } from './cup-pour-profile';

const seeds = [
  'motion-coverage-0',
  'motion-coverage-1',
  'motion-coverage-2',
  'motion-coverage-4',
  'motion-coverage-7',
  'motion-coverage-13',
  'motion-coverage-58',
  'motion-coverage-102',
];

describe('cup pour profile', () => {
  it('uses both seeded cup sides with stable release and tilt toward the center', () => {
    const area = rollAreaMeta();
    const sides = seeds.map((seed) => {
      const profile = createCupPourProfile(seed, area);
      expect(profile).toEqual(createCupPourProfile(seed, area));
      expect(Math.sign(profile.releaseX)).toBe(Math.sign(profile.stageX));
      expect(Math.sign(profile.stageX)).toBe(profile.side);
      expect(Math.abs(profile.releaseX)).toBeLessThan(Math.abs(profile.stageX));
      return Math.sign(profile.stageX);
    });

    expect(new Set(sides)).toEqual(new Set([-1, 1]));
  });
});
