import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, spyOn, test } from 'bun:test';

import {
  CUP_EXIT_HOLD_MS,
  type DieSlot,
  type QuaternionTuple,
  type Vector3Tuple,
} from '../contract';
import { DEFAULT_CUP_GEOMETRY } from '../contract/cup-geometry';
import { DIE_GEOMETRY } from '../contract/roll-geometry';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import { createCupMotion, cupTransformAt } from './internal/cup-motion';
import { haveDiceClearedCup } from './internal/physics-cup';
import { recognizeTopFace, rotateVectorByQuat } from './internal/result-recognition';
import { STEP } from './internal/roll-simulation-constants';
import { simulateRollTimeline } from './simulate-timeline';

beforeAll(initializeDeterministicRapierForBun);

test.each([
  ['oblique', 3, 'bfd0e79c0dc524db35c33408ce421d8aef7502590737f73b3f3e988eadcbda92'],
  ['burst', 3, '4784dec7144e75efeab828872fca6b46ff1b083f940cef555cb3771c2efe5aad'],
  ['burst', 3, '81629ce8e7ca36b160b19ed5a40de42ba2205c987d6b6bb5c83676725cc565c9'],
  ['burst', 3, 'a08e4eb983405c53f9fe27895447b35a5edfebf8928bc7fe7ddbe91d057d82cc'],
  ['classic', 4, 'f6456f17981b40171b1418bde30ae0d5f5a99681467f519dc5a5d5aefe1e52b1'],
  ['oblique', 5, '0f983d52407e097276f343be76137484967e6118962e2a39bb1ad7b1fb52f3ff'],
  ['oblique', 5, '9cba47b0031dae07923363b555ad2b0c64ac1632e34de021c759742d844e4f2e'],
  ['classic', 5, '09f803d73b17ab82d26895b1374bf828e61e53408667a16aacfb4f98445643a8'],
  ['classic', 5, 'a817e9de94909efed949d872b44be0f5ef4b1f69768b1c65fee5b73a4e9188c9'],
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

test.each(
  (['classic', 'burst', 'oblique'] as const).flatMap((style) =>
    [1, 2, 3, 4, 5].map((count) => [style, count] as const),
  ),
)('keeps the mouth closed through shaking/gathering, then opens for %s %i dice', (style, count) => {
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
    const t = Math.round(Math.floor(substep++ / 4) * STEP * 1000);
    const bodies: RAPIER.RigidBody[] = [];
    this.forEachRigidBody((body) => bodies.push(body));
    const cup = bodies.find((body) => body.isKinematic());
    if (!cup) return;
    const center = cup.translation();
    const normal = rotateVectorByQuat([0, 1, 0], cup.rotation());
    const ray = new RAPIER.Ray(center, { x: normal[0], y: normal[1], z: normal[2] });
    const blockedMouth = Array.from({ length: cup.numColliders() }, (_, i) => cup.collider(i)).some(
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
    expect(lastClosedAt).toBeGreaterThanOrEqual(motion.pourAtMs - STEP * 1000 - 1);
    expect(openThroughoutPour).toBe(true);
    expect(firstOpenAt).toBeGreaterThanOrEqual(motion.pourAtMs);
    expect(firstOpenAt).toBeLessThanOrEqual(motion.pourAtMs + STEP * 1000 + 1);
    expect(escapedWhileShaking).toBe(false);
    expect(timeline.cup.releaseAtMs).toBeGreaterThan(motion.pourAtMs);
  } finally {
    observer.mockRestore();
  }
});

test('mixes more than a lone top die during five-die cup shaking', () => {
  let tumbledDice = 0;
  for (let sequence = 0; sequence < 20; sequence += 1) {
    const seed = `cup-shake-mixing-${sequence}`;
    const timeline = simulateRollTimeline({
      rollId: seed,
      seed,
      rolledSlots: [0, 1, 2, 3, 4],
      pourStyle: 'classic',
    });
    for (const die of timeline.dice) {
      const initialTop = recognizeTopFace(die.frames[0]!.q);
      if (
        die.frames.some(
          (frame) => frame.t <= timeline.cup.pourAtMs && recognizeTopFace(frame.q) !== initialTop,
        )
      )
        tumbledDice += 1;
    }
  }
  // Detect the four-die locked bed, not a desired final face or score distribution.
  // At least 1.5 dice per roll must cross a face boundary before pouring starts.
  expect(tumbledDice).toBeGreaterThanOrEqual(30);
});

test('remembers a mouth crossing during shaking when the die later rests behind the cup', () => {
  const seed = 'early-mouth-crossing';
  const motion = createCupMotion(seed, 'classic');
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
    const t = Math.round((elapsedSeconds - STEP) * 1000);
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
      pourStyle: 'classic',
    });
    expect(timeline.cup.releaseAtMs).toBeGreaterThanOrEqual(motion.pourAtMs);
    expect(timeline.cup.releaseAtMs - motion.pourAtMs).toBeLessThan(100);
    expect(removedAtMs).toBeGreaterThanOrEqual(timeline.cup.exitAtMs);
  } finally {
    observer.mockRestore();
  }
});

test.each(['classic', 'burst'] as const)(
  'pours five %s dice without a late second batch',
  (style) => {
    const seeds =
      style === 'classic'
        ? Array.from({ length: 10 }, (_, sequence) => `coherent-pour-baseline-5-${sequence}`)
        : ['browser-parity-v1', 'coherent-pour-baseline-5-4', 'pour-direction-1'];
    for (const seed of seeds) {
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
        const t = Math.round((elapsedSeconds - STEP) * 1000);
        const bodies: RAPIER.RigidBody[] = [];
        this.forEachRigidBody((body) => bodies.push(body));
        const body = bodies.find((body) => body.isKinematic());
        if (!body || t < motion.pourAtMs) return;
        const cup = {
          body,
          colliders: Array.from({ length: body.numColliders() }, (_, i) => body.collider(i)),
        };
        for (const body of bodies.filter((body) => body.isDynamic())) {
          const die = { id: String(body.handle), body, collider: body.collider(0) };
          if (!exits.has(body.handle) && haveDiceClearedCup(this, cup, [die]))
            exits.set(body.handle, t);
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
        expect(
          Math.max(...times.slice(1).map((t, index) => t - times[index]!)),
        ).toBeLessThanOrEqual(250);
      } finally {
        observer.mockRestore();
      }
    }
  },
);

test('exposes the classic die beyond the opaque cup before its exit fade', () => {
  const timeline = simulateRollTimeline({
    rollId: 'classic-opaque-cup-occlusion',
    seed: 't7-tuning-1-1',
    rolledSlots: [0],
    pourStyle: 'classic',
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
});

test('fails a physically blocked cup without starting a timed exit', () => {
  const seed = 'blocked-cup-exit';
  const expected = cupTransformAt(createCupMotion(seed, 'classic'), 3000);
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
      simulateRollTimeline({ rollId: seed, seed, rolledSlots: [0], pourStyle: 'classic' }),
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

test.each([1, 5])('empties %i dice through the mouth before the cup starts exiting', (count) => {
  const timeline = simulateRollTimeline({
    rollId: `natural-cup-release-${count}`,
    seed: `t5-final-classic-${count}`,
    rolledSlots: Array.from({ length: count }, (_, i) => i as DieSlot),
    pourStyle: 'classic',
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
