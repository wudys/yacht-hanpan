import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, expect, test } from 'bun:test';

import { DEFAULT_CUP_GEOMETRY as CUP } from '../contract/cup-geometry';
import { DIE_GEOMETRY } from '../contract/roll-geometry';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import { createPhysicsCup } from '../simulate/internal/cup/physics-cup';
import { quatFromEuler, rotateVectorByQuat } from '../simulate/internal/simulation-math';
import { measureCupBottomBoundary } from './cup-boundary-audit';

beforeAll(initializeDeterministicRapierForBun);

const outerBottomY = -CUP.innerHeight / 2 - CUP.baseThickness;

test.each([
  { name: 'interior overlap hidden by the base', x: 0, bottom: -1.02, tilt: 0, crossing: false },
  { name: 'touching the external plane', x: 0, bottom: outerBottomY, tilt: 0, crossing: false },
  {
    name: 'Float32-scale contact roundoff',
    x: 0,
    bottom: outerBottomY - 0.0000001,
    tilt: 0,
    crossing: false,
  },
  {
    name: 'small measurable external crossing',
    x: 0,
    bottom: outerBottomY - 0.0001,
    tilt: 0,
    crossing: true,
  },
  { name: 'external bottom crossing', x: 0, bottom: outerBottomY - 0.04, tilt: 0, crossing: true },
  { name: 'a deep escape below a thin probe', x: 0, bottom: -3, tilt: 0, crossing: true },
  { name: 'outside the finite footprint', x: 3, bottom: -2, tilt: 0, crossing: false },
  {
    name: 'rotated die crossing the edge',
    x: 1.2,
    bottom: -1.2,
    tilt: Math.PI / 3,
    crossing: true,
  },
])('distinguishes $name in translated and rotated cup coordinates', (fixture) => {
  for (const pose of [
    { x: 0, y: 0, z: 0, yaw: 0, tilt: 0 },
    { x: 2, y: 3, z: -4, yaw: 0.4, tilt: Math.PI / 6 },
  ]) {
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    try {
      const cup = createPhysicsCup(world, pose, CUP);
      const roundRadius = DIE_GEOMETRY.colliderRadius;
      const halfExtent = DIE_GEOMETRY.size / 2 - roundRadius;
      const support =
        roundRadius +
        halfExtent * (Math.abs(Math.sin(fixture.tilt)) + Math.abs(Math.cos(fixture.tilt)));
      const localRotation = quatFromEuler(0, 0, fixture.tilt);
      const cupRotation = cup.body.rotation();
      // Composition qCup * qLocal, including yaw in the shared world pose.
      const rotation = {
        x:
          cupRotation.x * localRotation.w +
          cupRotation.w * localRotation.x +
          cupRotation.y * localRotation.z -
          cupRotation.z * localRotation.y,
        y:
          cupRotation.y * localRotation.w +
          cupRotation.w * localRotation.y +
          cupRotation.z * localRotation.x -
          cupRotation.x * localRotation.z,
        z:
          cupRotation.z * localRotation.w +
          cupRotation.w * localRotation.z +
          cupRotation.x * localRotation.y -
          cupRotation.y * localRotation.x,
        w:
          cupRotation.w * localRotation.w -
          cupRotation.x * localRotation.x -
          cupRotation.y * localRotation.y -
          cupRotation.z * localRotation.z,
      };
      const offset = rotateVectorByQuat([fixture.x, fixture.bottom + support, 0], cupRotation);
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(pose.x + offset[0], pose.y + offset[1], pose.z + offset[2])
          .setRotation(rotation),
      );
      const die = world.createCollider(
        RAPIER.ColliderDesc.roundCuboid(halfExtent, halfExtent, halfExtent, roundRadius),
        body,
      );
      const bodyCount = world.bodies.len();
      const colliderCount = world.colliders.len();
      const translation = body.translation();
      const report = measureCupBottomBoundary(die, cup.colliders[0]);
      expect(report.axisMinimumOuterGap).toBeCloseTo(
        fixture.bottom + CUP.innerHeight / 2 + CUP.baseThickness,
        5,
      );
      expect(
        Math.abs(
          report.axisMinimumOuterGap - (fixture.bottom + CUP.innerHeight / 2 + CUP.baseThickness),
        ),
      ).toBeLessThan(0.000002);
      expect(report.externalBottomCrossing).toBe(fixture.crossing);
      if (fixture.name === 'interior overlap hidden by the base')
        expect(report.baseContactDepth).toBeGreaterThan(0.019);
      if (fixture.name === 'rotated die crossing the edge') {
        // The lowest support point lies outside the radius, but part of the
        // rounded box still crosses the finite underside nearer the cup centre.
        const lowestPointX =
          fixture.x + halfExtent * (Math.sin(fixture.tilt) - Math.cos(fixture.tilt));
        expect(lowestPointX).toBeGreaterThan(CUP.bottomRadius + CUP.wallThickness);
      }
      expect(world.bodies.len()).toBe(bodyCount);
      expect(world.colliders.len()).toBe(colliderCount);
      expect(body.translation()).toEqual(translation);
    } finally {
      world.free();
    }
  }
});
