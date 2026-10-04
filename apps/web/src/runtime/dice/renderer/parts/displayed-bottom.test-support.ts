import { BufferGeometry, Matrix4, Vector2, Vector3 } from 'three';

// Test-only surface diagnostic: it measures geometric exposure, not visible pixels.
const CLIP_EPSILON = 1e-9;

export function baseFootprint(geometry: BufferGeometry): Vector2[] {
  const positions = geometry.getAttribute('position');
  const points = new Map<string, Vector2>();
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const z = positions.getZ(index);
    if (Math.hypot(x, z) > CLIP_EPSILON) {
      // CylinderGeometry repeats its seam; retain the actual coordinates while
      // treating its ~1e-16 sine difference as the same footprint corner.
      points.set(
        `${Math.round(x / CLIP_EPSILON)},${Math.round(z / CLIP_EPSILON)}`,
        new Vector2(x, z),
      );
    }
  }
  return [...points.values()].sort((a, b) => Math.atan2(a.y, a.x) - Math.atan2(b.y, b.x));
}

/** Clips actual rendered triangles to the finite cup base, including crossing edges. */
export function displayedBottomDepth(
  geometry: BufferGeometry,
  dieMatrix: Matrix4,
  cupMatrix: Matrix4,
  footprint: readonly Vector2[],
  outerBottomY: number,
): number {
  const relative = cupMatrix.clone().invert().multiply(dieMatrix);
  const positions = geometry.getAttribute('position');
  const vertices = Array.from({ length: positions.count }, (_, index) =>
    new Vector3().fromBufferAttribute(positions, index).applyMatrix4(relative),
  );
  // A triangle cannot extend below the minimum of its vertices. Most product
  // samples therefore need no clipping, even when their die touches the floor.
  if (vertices.every((vertex) => vertex.y >= outerBottomY)) return 0;

  const winding = Math.sign(
    footprint.reduce((area, a, index) => {
      const b = footprint[(index + 1) % footprint.length];
      return area + a.x * b.y - b.x * a.y;
    }, 0),
  );
  const indices = geometry.index;
  const count = indices?.count ?? positions.count;
  let minY = outerBottomY;
  for (let index = 0; index < count; index += 3) {
    let clipped = [0, 1, 2].map(
      (offset) => vertices[indices ? indices.getX(index + offset) : index + offset],
    );
    if (clipped.every((point) => point.y >= outerBottomY)) continue;
    for (let edge = 0; edge < footprint.length && clipped.length > 0; edge += 1) {
      const a = footprint[edge];
      const b = footprint[(edge + 1) % footprint.length];
      clipped = clipTriangle(clipped, a, b, winding);
    }
    for (const point of clipped) minY = Math.min(minY, point.y);
  }
  return outerBottomY - minY;
}

function clipTriangle(points: Vector3[], a: Vector2, b: Vector2, winding: number): Vector3[] {
  const distance = (point: Vector3) =>
    winding * ((b.x - a.x) * (point.z - a.y) - (b.y - a.y) * (point.x - a.x));
  const result: Vector3[] = [];
  let previous = points[points.length - 1];
  let previousDistance = distance(previous);
  for (const point of points) {
    const currentDistance = distance(point);
    const inside = currentDistance >= -CLIP_EPSILON;
    if (inside !== previousDistance >= -CLIP_EPSILON) {
      result.push(
        previous.clone().lerp(point, previousDistance / (previousDistance - currentDistance)),
      );
    }
    if (inside) result.push(point);
    previous = point;
    previousDistance = currentDistance;
  }
  return result;
}
