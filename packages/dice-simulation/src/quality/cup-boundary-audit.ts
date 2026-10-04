import RAPIER, { type Collider } from '@dimforge/rapier3d-deterministic';

import { rotateVectorByQuat } from '../simulate/internal/result-recognition';

// Rotated/translated Float32 collider fixtures bound world-coordinate roundoff to
// less than 2e-6. This is numerical contact tolerance, not allowed base penetration.
const CONTACT_EPSILON = 0.000002;

/** Offline query only. The caller excludes dice that already crossed the mouth. */
export function measureCupBottomBoundary(die: Collider, base: Collider) {
  const rotation = base.rotation();
  const center = base.translation();
  const axis = rotateVectorByQuat([0, 1, 0], rotation);
  const position = die.translation();
  const halfExtents = die.halfExtents();
  const dieRotation = die.rotation();
  const projectedExtent = (direction: [number, number, number], extent: number) => {
    const normal = rotateVectorByQuat(direction, dieRotation);
    return extent * Math.abs(normal[0] * axis[0] + normal[1] * axis[1] + normal[2] * axis[2]);
  };
  const support =
    die.roundRadius() +
    projectedExtent([1, 0, 0], halfExtents.x) +
    projectedExtent([0, 1, 0], halfExtents.y) +
    projectedExtent([0, 0, 1], halfExtents.z);
  const projectedCenter =
    (position.x - center.x) * axis[0] +
    (position.y - center.y) * axis[1] +
    (position.z - center.z) * axis[2];
  const outerBottom = -base.halfHeight();
  const axisMinimumOuterGap = projectedCenter - support - outerBottom;
  const contact = die.contactCollider(base, 0);
  let externalOverlapDepth = 0;
  if (axisMinimumOuterGap < -CONTACT_EPSILON) {
    // Cover the entire die below the underside, including bodies that escaped far
    // enough to miss a thin strip. The finite radius excludes movement beside it.
    const probeBottom = projectedCenter - support - CONTACT_EPSILON;
    const halfHeight = (outerBottom - probeBottom) / 2;
    const along = outerBottom - halfHeight;
    const externalContact = die.contactShape(
      new RAPIER.Cylinder(halfHeight, base.radius()),
      {
        x: center.x + axis[0] * along,
        y: center.y + axis[1] * along,
        z: center.z + axis[2] * along,
      },
      rotation,
      0,
    );
    externalOverlapDepth = externalContact ? Math.max(0, -externalContact.distance) : 0;
  }
  return {
    axisMinimumOuterGap,
    baseContactDepth: contact ? Math.max(0, -contact.distance) : 0,
    externalOverlapDepth,
    externalBottomCrossing: externalOverlapDepth > CONTACT_EPSILON,
  };
}
