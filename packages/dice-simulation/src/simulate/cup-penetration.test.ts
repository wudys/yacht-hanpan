import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, spyOn, test } from 'bun:test';

import { type DieSlot, POUR_STYLES } from '../contract';
import { DEFAULT_CUP_GEOMETRY as CUP } from '../contract/cup-geometry';
import { DIE_GEOMETRY } from '../contract/roll-geometry';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import { haveDiceClearedCup } from './internal/physics-cup';
import { rotateVectorByQuat } from './internal/result-recognition';
import { simulateRollTimeline } from './simulate-timeline';

beforeAll(initializeDeterministicRapierForBun);

const cases = POUR_STYLES.flatMap((pourStyle) =>
  [1, 2, 3, 4, 5].flatMap((count) =>
    Array.from({ length: 12 }, (_, index) => ({
      seed: `cup-bottom-probe-${index}`,
      pourStyle,
      count,
    })),
  ),
);

test.each(cases)(
  'keeps $seed ($pourStyle, $count dice) inside the base until mouth exit',
  ({ seed, pourStyle, count }) => {
    const stepWorld = RAPIER.World.prototype.step;
    const exited = new Set<number>();
    let maximumDepth = 0;
    let observedSteps = 0;
    const observer = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
      this: RAPIER.World,
      ...args: Parameters<typeof stepWorld>
    ) {
      stepWorld.apply(this, args);
      const bodies: RAPIER.RigidBody[] = [];
      this.forEachRigidBody((body) => bodies.push(body));
      const cupBody = bodies.find((body) => body.isKinematic());
      if (!cupBody) return;
      observedSteps += 1;
      const cup = {
        body: cupBody,
        colliders: Array.from({ length: cupBody.numColliders() }, (_, i) => cupBody.collider(i)),
      };
      for (const body of bodies.filter((body) => body.isDynamic())) {
        const die = { body, collider: body.collider(0), id: String(body.handle) };
        if (haveDiceClearedCup(this, cup, [die])) exited.add(body.handle);
        // Released dice can legitimately bounce below the finite cup.
        if (exited.has(body.handle)) continue;
        maximumDepth = Math.max(maximumDepth, basePenetration(body, cupBody));
      }
    });
    try {
      simulateRollTimeline({
        rollId: seed,
        seed,
        pourStyle,
        rolledSlots: Array.from({ length: count }, (_, i) => i as DieSlot),
      });
      expect(observedSteps).toBeGreaterThan(0);
      expect(exited.size).toBe(count);
      // Leave half the visible base thickness as margin; zero solver overlap is not required.
      expect(maximumDepth).toBeLessThanOrEqual(CUP.baseThickness / 2);
    } finally {
      observer.mockRestore();
    }
  },
);

function basePenetration(die: RAPIER.RigidBody, cup: RAPIER.RigidBody): number {
  const cupQ = cup.rotation();
  const dieQ = die.rotation();
  const down = rotateVectorByQuat([0, -1, 0], cupQ);
  const localDown = rotateVectorByQuat(down, inverse(dieQ));
  const core = DIE_GEOMETRY.size / 2 - DIE_GEOMETRY.colliderRadius;
  // Support point of the rounded cuboid toward the cup floor, not its centre/AABB.
  const support = rotateVectorByQuat(
    localDown.map((v) => Math.sign(v) * core + v * DIE_GEOMETRY.colliderRadius) as [
      number,
      number,
      number,
    ],
    dieQ,
  );
  const p = die.translation();
  const c = cup.translation();
  const point = rotateVectorByQuat(
    [p.x - c.x + support[0], p.y - c.y + support[1], p.z - c.z + support[2]],
    inverse(cupQ),
  );
  if (Math.hypot(point[0], point[2]) > CUP.bottomRadius) return 0;
  return Math.max(0, -CUP.innerHeight / 2 - point[1]);
}

function inverse(q: RAPIER.Rotation): RAPIER.Rotation {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}
