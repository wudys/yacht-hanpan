/** Local origin is halfway between the inner floor and the open mouth. */
export type CupGeometry = Readonly<{
  innerRadius: number;
  bottomRadius: number;
  innerHeight: number;
  wallThickness: number;
  baseThickness: number;
  segments: number;
}>;

export const DEFAULT_CUP_GEOMETRY: CupGeometry = Object.freeze({
  innerRadius: 1.18,
  bottomRadius: 1.14,
  innerHeight: 2,
  wallThickness: 0.08,
  baseThickness: 0.1,
  segments: 24,
});

/** The same convex wall sections are used for collision and the visible shell. */
export function cupWallVertices(
  segment: number,
  spec: CupGeometry = DEFAULT_CUP_GEOMETRY,
): Float32Array {
  const vertices: number[] = [];
  for (const [y, radius] of [
    [-spec.innerHeight / 2, spec.bottomRadius],
    [spec.innerHeight / 2, spec.innerRadius],
  ]) {
    for (const r of [radius, radius + spec.wallThickness]) {
      for (const edge of [segment, segment + 1]) {
        const angle = (edge / spec.segments) * Math.PI * 2;
        vertices.push(Math.cos(angle) * r, y, Math.sin(angle) * r);
      }
    }
  }
  return new Float32Array(vertices);
}

/** Distance below the pivot, including the underside and the outer wall sweep. */
export function cupLowerSupport(tilt: number, spec: CupGeometry = DEFAULT_CUP_GEOMETRY): number {
  const c = Math.cos(tilt);
  const s = Math.abs(Math.sin(tilt));
  const halfHeight = spec.innerHeight / 2;
  return Math.max(
    (halfHeight + spec.baseThickness) * c + (spec.bottomRadius + spec.wallThickness) * s,
    halfHeight * c + (spec.bottomRadius + spec.wallThickness) * s,
    -halfHeight * c + (spec.innerRadius + spec.wallThickness) * s,
  );
}
