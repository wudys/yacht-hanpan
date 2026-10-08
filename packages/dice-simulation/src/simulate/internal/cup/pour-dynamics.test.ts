import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, test } from 'bun:test';

import { DEFAULT_CUP_GEOMETRY } from '../../../contract/cup-geometry';
import { initializeDeterministicRapierForBun } from '../../../rapier/bun';
import { simulateRollTimeline } from '../../simulate-physics';
import { createRollPhysicsConfig } from '../physics-config';
import { createDieInCup } from '../physics-environment';
import { FIXED_STEP_SECONDS } from '../roll-simulation-constants';
import { rotateVectorByQuat } from '../simulation-math';
import { createCupMotion, cupTransformAt } from './cup-motion';
import { applyCupPourAssist, createPhysicsCup } from './physics-cup';

beforeAll(initializeDeterministicRapierForBun);

test.each(['classic', 'burst', 'oblique'] as const)(
  'confines %s pour assistance to the tilted cup interior and its short release window',
  (style) => {
    const seed = 'pour-assist-boundary';
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    try {
      const motion = createCupMotion(seed, style);
      const start = motion.pourAtMs + 300;
      const t = start + 100;
      const pose = cupTransformAt(motion, t);
      const cup = createPhysicsCup(world, pose, DEFAULT_CUP_GEOMETRY);
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
      expect(apply(t, DEFAULT_CUP_GEOMETRY.innerHeight / 2 + 0.1)).toBe(0);
      expect(apply(t, 0, true)).toBe(0);
      expect(apply(t, 0)).toBeCloseTo(20 * FIXED_STEP_SECONDS, 5);
      const v = die.body.linvel();
      expect(v.x).toBeCloseTo(axis[0] * 20 * FIXED_STEP_SECONDS, 5);
      expect(v.y).toBeCloseTo(axis[1] * 20 * FIXED_STEP_SECONDS, 5);
      expect(die.body.angvel()).toEqual({ x: 0, y: 0, z: 0 });
      die.body.setTranslation(
        { x: pose.x, y: pose.y, z: pose.z + DEFAULT_CUP_GEOMETRY.innerRadius + 0.1 },
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

test('physically tumbles the single die during actual shaking before pouring starts', () => {
  const seed = 'dice-quality-tuning-classic-1-0';
  const timeline = simulateRollTimeline({
    rollId: seed,
    seed,
    rolledSlots: [0],
    pourStyle: 'classic',
  });
  const { frames } = timeline.dice[0]!;
  const first = frames[0]!.q;
  // Track the body axis that pointed upward at the first sample, excluding yaw/jitter.
  const initialUp = rotateVectorByQuat([0, 1, 0], {
    x: -first[0],
    y: -first[1],
    z: -first[2],
    w: first[3],
  });
  let largestExcursion = 0;
  let observedShakeFrames = 0;
  for (const frame of frames) {
    if (frame.t >= timeline.cup.pourAtMs) continue;
    observedShakeFrames += 1;
    const up = rotateVectorByQuat(initialUp, {
      x: frame.q[0],
      y: frame.q[1],
      z: frame.q[2],
      w: frame.q[3],
    });
    const cosine = up[1] / Math.hypot(...up);
    largestExcursion = Math.max(largestExcursion, Math.acos(Math.min(1, Math.max(-1, cosine))));
  }
  expect(observedShakeFrames).toBeGreaterThan(1);
  // A quarter turn proves a tumble; neither its exact angle nor a final face is prescribed.
  expect(largestExcursion).toBeGreaterThan(Math.PI / 2);
});
