import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, test } from 'bun:test';

import { initializeDeterministicRapierForBun } from '../../rapier/bun';
import { createCupMotion, cupTransformAt } from './cup-motion';
import { DEFAULT_CUP_SPEC } from './cup-spec';
import { applyCupPourAssist, createPhysicsCup, updatePhysicsCup } from './physics-cup';
import { createDieInCup, createTray } from './physics-environment';
import { rotateVectorByQuat } from './result-recognition';
import { createRollPhysicsConfig } from './roll-physics';
import { STEP } from './roll-simulation-constants';

beforeAll(initializeDeterministicRapierForBun);

test.each(['classic', 'burst', 'oblique'] as const)(
  'confines %s pour assistance to the tilted cup interior and its short release window',
  (style) => {
    const seed = 'pour-assist-boundary';
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    try {
      const motion = createCupMotion(seed, style);
      const start = motion.pourAtMs + (style === 'burst' ? 210 : 300);
      const t = start + 100;
      const pose = cupTransformAt(motion, t);
      const cup = createPhysicsCup(world, pose, DEFAULT_CUP_SPEC);
      const die = createDieInCup(world, seed, 0, 1, motion, createRollPhysicsConfig());
      const axis = rotateVectorByQuat([0, 1, 0], cup.body.rotation());
      const apply = (time: number, along: number, exited = false) => {
        die.body.setTranslation(
          { x: pose.x + axis[0] * along, y: pose.y + axis[1] * along, z: pose.z + axis[2] * along },
          false,
        );
        die.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        die.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
        applyCupPourAssist(cup, [die], motion, time, new Set(exited ? [die.id] : []));
        const v = die.body.linvel();
        return Math.hypot(v.x, v.y, v.z);
      };
      expect(apply(start - 1, 0)).toBe(0);
      expect(apply(start + 450, 0)).toBe(0);
      expect(apply(t, DEFAULT_CUP_SPEC.innerHeight / 2 + 0.1)).toBe(0);
      expect(apply(t, 0, true)).toBe(0);
      expect(apply(t, 0)).toBeCloseTo(20 * STEP, 5);
      const v = die.body.linvel();
      expect(v.x).toBeCloseTo(axis[0] * 20 * STEP, 5);
      expect(v.y).toBeCloseTo(axis[1] * 20 * STEP, 5);
      expect(die.body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
      die.body.setTranslation(
        { x: pose.x, y: pose.y, z: pose.z + DEFAULT_CUP_SPEC.innerRadius + 0.1 },
        false,
      );
      die.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      applyCupPourAssist(cup, [die], motion, t, new Set());
      expect(die.body.linvel()).toEqual({ x: 0, y: 0, z: 0 });
      cup.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, false);
      expect(apply(t, 0)).toBe(0);
    } finally {
      world.free();
    }
  },
);

test.each([1, 5])(
  'physically tumbles %i-die samples during shaking, not only after release',
  (count) => {
    let largestExcursion = 0;
    for (let sequence = 0; sequence < 20; sequence += 1) {
      const seed = `dice-quality-tuning-classic-${count}-${sequence}`;
      const physics = createRollPhysicsConfig();
      const world = new RAPIER.World({ x: 0, y: physics.gravity, z: 0 });
      try {
        world.timestep = STEP;
        createTray(world, physics);
        const motion = createCupMotion(seed, 'classic');
        const cup = createPhysicsCup(world, cupTransformAt(motion, 0), DEFAULT_CUP_SPEC);
        const dice = Array.from({ length: count }, (_, index) =>
          createDieInCup(world, seed, index, count, motion, physics),
        );
        const initialUp = dice.map((die) => {
          const q = die.body.rotation();
          return rotateVectorByQuat([0, 1, 0], { x: -q.x, y: -q.y, z: -q.z, w: q.w });
        });
        for (let step = 0; step * STEP * 1000 < motion.pourAtMs; step += 1) {
          const timeMs = Math.round(step * STEP * 1000);
          updatePhysicsCup(cup, cupTransformAt(motion, timeMs));
          world.step();
          dice.forEach((die, index) => {
            const up = rotateVectorByQuat(initialUp[index]!, die.body.rotation());
            const cosine = up[1] / Math.hypot(...up);
            largestExcursion = Math.max(
              largestExcursion,
              Math.acos(Math.min(1, Math.max(-1, cosine))),
            );
          });
        }
      } finally {
        world.free();
      }
    }
    // Tilting the original up axis by a quarter turn distinguishes a tumble from yaw/jitter.
    // No particular face, number of face changes, or every-roll outcome is required.
    expect(largestExcursion).toBeGreaterThan(Math.PI / 2);
  },
);
