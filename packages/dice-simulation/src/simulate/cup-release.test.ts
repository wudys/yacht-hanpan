import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, spyOn, test } from 'bun:test';

import {
  CUP_EXIT_HOLD_MS,
  type DieSlot,
  POUR_STYLES,
  type QuaternionTuple,
  type Vector3Tuple,
} from '../contract';
import { DEFAULT_CUP_GEOMETRY } from '../contract/cup-geometry';
import { DIE_GEOMETRY } from '../contract/roll-geometry';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import { createCupMotion, cupTransformAt } from './internal/cup/cup-motion';
import * as cupPhysics from './internal/cup/physics-cup';
import { haveDiceClearedCupMouth } from './internal/cup/physics-cup';
import { recognizeTopFace } from './internal/result-recognition';
import { FIXED_STEP_SECONDS } from './internal/roll-simulation-constants';
import { rotateVectorByQuat } from './internal/simulation-math';
import { simulateRollTimeline } from './simulate-physics';
import { evaluateRollCandidate } from './simulate-roll';

beforeAll(initializeDeterministicRapierForBun);

test.each([
  ['oblique', 3, 'bfd0e79c0dc524db35c33408ce421d8aef7502590737f73b3f3e988eadcbda92'],
  ['burst', 3, '4784dec7144e75efeab828872fca6b46ff1b083f940cef555cb3771c2efe5aad'],
  ['burst', 3, '81629ce8e7ca36b160b19ed5a40de42ba2205c987d6b6bb5c83676725cc565c9'],
  ['burst', 3, 'a08e4eb983405c53f9fe27895447b35a5edfebf8928bc7fe7ddbe91d057d82cc'],
  ['oblique', 4, 'f6456f17981b40171b1418bde30ae0d5f5a99681467f519dc5a5d5aefe1e52b1'],
  ['oblique', 5, '0f983d52407e097276f343be76137484967e6118962e2a39bb1ad7b1fb52f3ff'],
  ['oblique', 5, '9cba47b0031dae07923363b555ad2b0c64ac1632e34de021c759742d844e4f2e'],
  ['oblique', 5, '09f803d73b17ab82d26895b1374bf828e61e53408667a16aacfb4f98445643a8'],
  ['oblique', 5, 'a817e9de94909efed949d872b44be0f5ef4b1f69768b1c65fee5b73a4e9188c9'],
  ['oblique', 4, '0601513f8d98fa4fbf0698a8799e5811af3a242b143cfe92d12a634ad84fa803'],
  ['oblique', 5, '0da2621d62547f5ee880f4f5c850e84e2737332f600d72e52ab77ad05913e192'],
] as const)(
  'releases %s %i dice without wedging the outer base against the tray (%s)',
  (pourStyle, count, seed) => {
    const timeline = simulateRollTimeline({
      rollId: 'cup-base-clearance-regression',
      seed,
      pourStyle,
      rolledSlots: [0, 1, 2, 3, 4].slice(0, count) as DieSlot[],
    });
    expect(timeline.cup.releaseAtMs).toBeGreaterThanOrEqual(timeline.cup.pourAtMs);
    expect(timeline.cup.frames.at(-1)!.visible).toBe(false);
    expect(timeline.dice).toHaveLength(count);
  },
);

test.each(POUR_STYLES.flatMap((style) => [1, 2, 3, 4, 5].map((count) => [style, count] as const)))(
  'keeps the mouth closed through shaking/gathering, then opens for %s %i dice',
  (style, count) => {
    const seed = '4784dec7144e75efeab828872fca6b46ff1b083f940cef555cb3771c2efe5aad';
    const motion = createCupMotion(seed, style);
    const stepWorld = RAPIER.World.prototype.step;
    let substep = 0;
    let closedThroughoutShake = true;
    let openThroughoutPour = true;
    let lastClosedAt = -1;
    let firstOpenAt = Infinity;
    let escapedWhileShaking = false;
    const observer = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
      this: RAPIER.World,
      ...args: Parameters<typeof stepWorld>
    ) {
      stepWorld.apply(this, args);
      const bodies: RAPIER.RigidBody[] = [];
      this.forEachRigidBody((body) => bodies.push(body));
      const cup = bodies.find((body) => body.isKinematic());
      if (!cup) return;
      const substeps = Math.round(FIXED_STEP_SECONDS / this.timestep);
      const t = Math.round(Math.floor(substep++ / substeps) * FIXED_STEP_SECONDS * 1000);
      const center = cup.translation();
      const normal = rotateVectorByQuat([0, 1, 0], cup.rotation());
      const ray = new RAPIER.Ray(center, { x: normal[0], y: normal[1], z: normal[2] });
      const blockedMouth = Array.from({ length: cup.numColliders() }, (_, i) =>
        cup.collider(i),
      ).some(
        (collider) => collider.castRay(ray, DEFAULT_CUP_GEOMETRY.innerHeight / 2 + 0.02, true) >= 0,
      );
      if (t >= motion.pourAtMs) {
        openThroughoutPour &&= !blockedMouth;
        if (!blockedMouth) firstOpenAt = Math.min(firstOpenAt, t);
        return;
      }
      closedThroughoutShake &&= blockedMouth;
      if (blockedMouth) lastClosedAt = t;
      for (const die of bodies.filter((body) => body.isDynamic())) {
        const p = die.translation();
        const q = die.rotation();
        const core = DIE_GEOMETRY.size / 2 - DIE_GEOMETRY.colliderRadius;
        const support =
          DIE_GEOMETRY.colliderRadius +
          core *
            (
              [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
              ] as Vector3Tuple[]
            ).reduce((sum, axis) => sum + Math.abs(dot(rotateVectorByQuat(axis, q), normal)), 0);
        const projection = dot([p.x - center.x, p.y - center.y, p.z - center.z], normal);
        escapedWhileShaking ||= projection - support > DEFAULT_CUP_GEOMETRY.innerHeight / 2 + 0.005;
      }
    });
    try {
      const timeline = simulateRollTimeline({
        rollId: 'shake-containment-regression',
        seed,
        pourStyle: style,
        rolledSlots: [0, 1, 2, 3, 4].slice(0, count) as DieSlot[],
      });
      expect(closedThroughoutShake).toBe(true);
      expect(lastClosedAt).toBeGreaterThanOrEqual(motion.pourAtMs - FIXED_STEP_SECONDS * 1000 - 1);
      expect(openThroughoutPour).toBe(true);
      expect(firstOpenAt).toBeGreaterThanOrEqual(motion.pourAtMs);
      expect(firstOpenAt).toBeLessThanOrEqual(motion.pourAtMs + FIXED_STEP_SECONDS * 1000 + 1);
      expect(escapedWhileShaking).toBe(false);
      expect(timeline.cup.releaseAtMs).toBeGreaterThan(motion.pourAtMs);
    } finally {
      observer.mockRestore();
    }
  },
);

test.each(POUR_STYLES.flatMap((style) => [1, 2, 3, 4, 5].map((count) => [style, count] as const)))(
  'adds one inward impulse only after each %s %i-die roll clears the mouth',
  (pourStyle, count) => {
    const createCup = cupPhysics.createPhysicsCup;
    const { applyImpulse } = RAPIER.RigidBody.prototype;
    let cup: cupPhysics.PhysicsCup | undefined;
    const applications = new Map<number, number>();
    const createSpy = spyOn(cupPhysics, 'createPhysicsCup').mockImplementation((...args) => {
      cup = createCup(...args);
      return cup;
    });
    const impulseSpy = spyOn(RAPIER.RigidBody.prototype, 'applyImpulse').mockImplementation(
      function (this: RAPIER.RigidBody, ...args: Parameters<typeof applyImpulse>) {
        const [impulse] = args;
        // Interior assistance has a vertical component; settling starts after removal.
        const exitImpulse =
          cup?.body.isValid() && impulse.x !== 0 && impulse.y === 0 && impulse.z === 0;
        const before = this.linvel();
        const angularBefore = this.angvel();
        applyImpulse.apply(this, args);
        if (!exitImpulse || !cup) return;
        expect(
          haveDiceClearedCupMouth(cup, [
            { id: String(this.handle), body: this, collider: this.collider(0) },
          ]),
        ).toBe(true);
        const after = this.linvel();
        const inward = cup.body.translation().x > 0 ? -1 : 1;
        expect(after.x - before.x).toBeCloseTo(inward * (count === 5 ? 0.5 : 1.5), 5);
        expect(after.y).toBe(before.y);
        expect(after.z).toBe(before.z);
        expect(this.angvel()).toEqual(angularBefore);
        applications.set(this.handle, (applications.get(this.handle) ?? 0) + 1);
      },
    );
    try {
      const timeline = simulateRollTimeline({
        rollId: 'cup-exit-impulse',
        seed: 'cup-exit-impulse',
        pourStyle,
        rolledSlots: [0, 1, 2, 3, 4].slice(0, count) as DieSlot[],
      });
      expect(timeline.dice).toHaveLength(count);
      expect(applications.size).toBe(count);
      expect([...applications.values()]).toEqual(Array(count).fill(1));
    } finally {
      impulseSpy.mockRestore();
      createSpy.mockRestore();
    }
  },
);

test('mixes more than a lone top die during five-die cup shaking', async () => {
  let tumbledDice = 0;
  for (let sequence = 0; sequence < 20; sequence += 1) {
    const seed = `cup-shake-mixing-${sequence}`;
    const motion = createCupMotion(seed, 'oblique');
    const initialFaces = new Map<number, number>();
    const tumbled = new Set<number>();
    let elapsedSeconds = 0;
    const stepWorld = RAPIER.World.prototype.step;
    const topFace = (body: RAPIER.RigidBody) => {
      const q = body.rotation();
      return recognizeTopFace([q.x, q.y, q.z, q.w]);
    };
    const observer = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
      this: RAPIER.World,
      ...args: Parameters<typeof stepWorld>
    ) {
      this.forEachRigidBody((body) => {
        if (body.isDynamic() && !initialFaces.has(body.handle))
          initialFaces.set(body.handle, topFace(body));
      });
      stepWorld.apply(this, args);
      elapsedSeconds += this.timestep;
      if (elapsedSeconds * 1000 > motion.pourAtMs) return;
      this.forEachRigidBody((body) => {
        if (body.isDynamic() && topFace(body) !== initialFaces.get(body.handle))
          tumbled.add(body.handle);
      });
    });
    try {
      // Shaking is observable even if this candidate is later rejected at rest.
      const candidate = await evaluateRollCandidate({
        rollId: seed,
        seed,
        rolledSlots: [0, 1, 2, 3, 4],
        pourStyle: 'oblique',
      });
      expect(['accepted', 'rejected']).toContain(candidate.status);
      expect(initialFaces.size).toBe(5);
      tumbledDice += tumbled.size;
    } finally {
      observer.mockRestore();
    }
  }
  // Detect the four-die locked bed, not a desired final face or score distribution.
  // At least 1.5 dice per roll must cross a face boundary before pouring starts.
  expect(tumbledDice).toBeGreaterThanOrEqual(30);
});

test('remembers a mouth crossing during shaking when the die later rests behind the cup', () => {
  const seed = 'early-mouth-crossing';
  const motion = createCupMotion(seed, 'oblique');
  const stepWorld = RAPIER.World.prototype.step;
  let elapsedSeconds = 0;
  let placedOnTray = false;
  let removedAtMs: number | undefined;
  const observer = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
    this: RAPIER.World,
    ...args: Parameters<typeof stepWorld>
  ) {
    stepWorld.apply(this, args);
    elapsedSeconds += this.timestep;
    const t = Math.round((elapsedSeconds - FIXED_STEP_SECONDS) * 1000);
    const bodies: RAPIER.RigidBody[] = [];
    this.forEachRigidBody((body) => bodies.push(body));
    const cup = bodies.find((body) => body.isKinematic());
    const die = bodies.find((body) => body.isDynamic())!;
    if (cup) {
      // Exercise an early complete exit followed by a position behind the tilted
      // cup. Clearance history must survive the later change in mouth direction.
      const axis = rotateVectorByQuat([0, 1, 0], cup.rotation());
      const distance = t < motion.pourAtMs ? 3 : -3;
      const center = cup.translation();
      die.setTranslation(
        {
          x: center.x + axis[0] * distance,
          y: center.y + axis[1] * distance,
          z: center.z + axis[2] * distance,
        },
        true,
      );
      die.setLinvel({ x: 0, y: 0, z: 0 }, true);
      die.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.propagateModifiedBodyPositionsToColliders();
    } else if (!placedOnTray) {
      removedAtMs = t;
      die.setTranslation({ x: 0, y: 1, z: 0 }, true);
      die.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      die.setLinvel({ x: 0, y: 0, z: 0 }, true);
      die.setAngvel({ x: 0, y: 0, z: 0 }, true);
      placedOnTray = true;
    }
  });
  try {
    const timeline = simulateRollTimeline({
      rollId: seed,
      seed,
      rolledSlots: [0],
      pourStyle: 'oblique',
    });
    expect(timeline.cup.releaseAtMs).toBeGreaterThanOrEqual(motion.pourAtMs);
    expect(timeline.cup.releaseAtMs - motion.pourAtMs).toBeLessThan(100);
    expect(removedAtMs).toBeGreaterThanOrEqual(timeline.cup.exitAtMs);
  } finally {
    observer.mockRestore();
  }
});

test.each(
  (['oblique', 'burst'] as const).flatMap((style) => {
    const seeds =
      style === 'oblique'
        ? Array.from({ length: 10 }, (_, sequence) => `coherent-pour-baseline-5-${sequence}`)
        : ['browser-parity-v1', 'coherent-pour-baseline-5-4', 'pour-direction-1'];
    return seeds.map((seed) => [style, seed] as const);
  }),
)('pours five %s dice without a late second batch for %s', (style, seed) => {
  const motion = createCupMotion(seed, style);
  const exits = new Map<number, number>();
  let elapsedSeconds = 0;
  const stepWorld = RAPIER.World.prototype.step;
  const observer = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
    this: RAPIER.World,
    ...args: Parameters<typeof stepWorld>
  ) {
    stepWorld.apply(this, args);
    elapsedSeconds += this.timestep;
    const t = Math.round((elapsedSeconds - FIXED_STEP_SECONDS) * 1000);
    const bodies: RAPIER.RigidBody[] = [];
    this.forEachRigidBody((body) => bodies.push(body));
    const body = bodies.find((body) => body.isKinematic());
    if (!body || t < motion.pourAtMs) return;
    const cup = {
      geometry: DEFAULT_CUP_GEOMETRY,
      body,
      colliders: Array.from({ length: body.numColliders() }, (_, i) => body.collider(i)),
    };
    for (const body of bodies.filter((body) => body.isDynamic())) {
      const die = { id: String(body.handle), body, collider: body.collider(0) };
      if (!exits.has(body.handle) && haveDiceClearedCupMouth(cup, [die])) exits.set(body.handle, t);
    }
  });
  try {
    simulateRollTimeline({
      rollId: seed,
      seed,
      rolledSlots: [0, 1, 2, 3, 4],
      pourStyle: style,
    });
    expect(exits.size).toBe(5);
    const times = [...exits.values()].sort((a, b) => a - b);
    // An early die is fine; a long wait for the next die reads as another pour.
    // Bound inter-die pauses, not the duration of a continuous five-die stream.
    expect(Math.max(...times.slice(1).map((t, index) => t - times[index]!))).toBeLessThanOrEqual(
      250,
    );
  } finally {
    observer.mockRestore();
  }
});

test.each([...POUR_STYLES])(
  'exposes the %s die beyond the opaque cup before its exit fade',
  (pourStyle) => {
    const timeline = simulateRollTimeline({
      rollId: 'selected-style-opaque-cup-occlusion',
      seed: 't7-tuning-1-1',
      rolledSlots: [0],
      pourStyle,
    });
    // Observe the last opaque sample, not an arbitrary point during clearance.
    const time = timeline.cup.releaseAtMs + CUP_EXIT_HOLD_MS - 1;
    const cup = timeline.cup.frames.filter((frame) => frame.t <= time).at(-1)!;
    const die = timeline.dice[0]!.frames.filter((frame) => frame.t <= time).at(-1)!;
    const q = { x: cup.q[0], y: cup.q[1], z: cup.q[2], w: cup.q[3] };
    const axis = rotateVectorByQuat([0, 1, 0], q);
    const spec = DEFAULT_CUP_GEOMETRY;
    // Screen-x bounds for the complete shell and the die's observed orientation.
    const cupHalfWidth =
      (spec.innerRadius + spec.wallThickness) * Math.sqrt(1 - axis[0] ** 2) +
      (spec.innerHeight / 2 + spec.baseThickness) * Math.abs(axis[0]);
    const dieQ = { x: die.q[0], y: die.q[1], z: die.q[2], w: die.q[3] };
    const dieHalfWidth =
      (DIE_GEOMETRY.size / 2) *
      (Math.abs(rotateVectorByQuat([1, 0, 0], dieQ)[0]) +
        Math.abs(rotateVectorByQuat([0, 1, 0], dieQ)[0]) +
        Math.abs(rotateVectorByQuat([0, 0, 1], dieQ)[0]));
    expect(Math.abs(die.p[0] - cup.p[0]) - cupHalfWidth - dieHalfWidth).toBeGreaterThan(0);
  },
);

test('fails a physically blocked cup without starting a timed exit', () => {
  const seed = 'blocked-cup-exit';
  const expected = cupTransformAt(createCupMotion(seed, 'oblique'), 3000);
  const createBody = RAPIER.World.prototype.createRigidBody;
  const stepWorld = RAPIER.World.prototype.step;
  let cupBody: RAPIER.RigidBody | undefined;
  let lastPosition: RAPIER.Vector | undefined;
  // Failure injection at the real physics boundary: a solid lid prevents exit.
  const createSpy = spyOn(RAPIER.World.prototype, 'createRigidBody').mockImplementation(function (
    this: RAPIER.World,
    desc: RAPIER.RigidBodyDesc,
  ) {
    const body = createBody.call(this, desc);
    if (body.isKinematic()) {
      cupBody = body;
      this.createCollider(
        RAPIER.ColliderDesc.cylinder(
          0.08,
          DEFAULT_CUP_GEOMETRY.innerRadius + DEFAULT_CUP_GEOMETRY.wallThickness,
        ).setTranslation(0, DEFAULT_CUP_GEOMETRY.innerHeight / 2 + 0.08, 0),
        body,
      );
    }
    return body;
  });
  const stepSpy = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
    this: RAPIER.World,
    ...args: Parameters<typeof stepWorld>
  ) {
    stepWorld.apply(this, args);
    if (cupBody?.isValid()) lastPosition = cupBody.translation();
  });
  try {
    expect(() =>
      simulateRollTimeline({ rollId: seed, seed, rolledSlots: [0], pourStyle: 'oblique' }),
    ).toThrow('Cup did not empty through its mouth');
    expect(lastPosition!.x).toBeCloseTo(expected.x, 5);
    expect(lastPosition!.y).toBeCloseTo(expected.y, 5);
  } finally {
    createSpy.mockRestore();
    stepSpy.mockRestore();
  }
});

test('allows a released die to bounce below the cup while the remaining dice leave', () => {
  const timeline = simulateRollTimeline({
    rollId: 'cup-exit-bounce-regression',
    seed: 'dice-quality-validation-toss-5-25',
    rolledSlots: [0, 1, 2, 3, 4],
    pourStyle: 'burst',
  });
  expect(timeline.dice).toHaveLength(5);
  expect(timeline.cup.releaseAtMs).toBeLessThan(3000);
  expect(timeline.cup.frames.some((frame) => frame.mode === 'exit')).toBe(true);
});

test.each([
  { count: 1, seed: 't5-final-classic-1' },
  { count: 5, seed: 't5-final-classic-5' },
  // Retain the historical seed while exercising a supported gesture.
  { count: 1, seed: 't7-tuning-1-1' },
])('empties $count oblique dice through the mouth before exit ($seed)', ({ count, seed }) => {
  const timeline = simulateRollTimeline({
    rollId: `natural-cup-release-${count}`,
    seed,
    rolledSlots: Array.from({ length: count }, (_, i) => i as DieSlot),
    pourStyle: 'oblique',
  });
  const cupFrame = [...timeline.cup.frames].reverse().find((frame) => frame.mode === 'pour')!;
  expect(cupFrame).toBeDefined();
  const openingY = DEFAULT_CUP_GEOMETRY.innerHeight / 2;
  const normal = rotated([0, 1, 0], cupFrame.q);

  for (const die of timeline.dice) {
    const frame = [...die.frames].reverse().find((frame) => frame.t <= cupFrame.t)!;
    const offset: Vector3Tuple = [
      frame.p[0] - cupFrame.p[0],
      frame.p[1] - cupFrame.p[1],
      frame.p[2] - cupFrame.p[2],
    ];
    // The farthest corner toward the cup must also clear the opening. A visible
    // face or the centre crossing alone does not prove the die has escaped.
    const core = DIE_GEOMETRY.size / 2 - DIE_GEOMETRY.colliderRadius;
    const axes: Vector3Tuple[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const support =
      DIE_GEOMETRY.colliderRadius +
      core * axes.reduce((sum, axis) => sum + Math.abs(dot(rotated(axis, frame.q), normal)), 0);
    expect(dot(offset, normal) - support - openingY).toBeGreaterThan(0);
  }
});

function rotated(v: Vector3Tuple, q: QuaternionTuple): Vector3Tuple {
  return rotateVectorByQuat(v, { x: q[0], y: q[1], z: q[2], w: q[3] });
}

function dot(a: Vector3Tuple, b: Vector3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
