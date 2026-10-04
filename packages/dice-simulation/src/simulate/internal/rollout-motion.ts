export type PlanarMotion = { x: number; z: number };

export type MotionCapPoint = {
  t: number;
  value: number;
};

export function limitPlanarVelocity(
  velocity: PlanarMotion,
  limits: { maxX: number; maxZ: number },
): PlanarMotion {
  const scale = Math.max(Math.abs(velocity.x) / limits.maxX, Math.abs(velocity.z) / limits.maxZ, 1);
  return { x: velocity.x / scale, z: velocity.z / scale };
}

export function interpolateMotionCap(time: number, points: MotionCapPoint[]): number {
  if (points.length === 0) return Infinity;
  if (time <= points[0].t) return points[0].value;

  for (let index = 1; index < points.length; index += 1) {
    const next = points[index];
    if (time > next.t) continue;
    const previous = points[index - 1];
    const alpha = (time - previous.t) / Math.max(Number.EPSILON, next.t - previous.t);
    return previous.value + (next.value - previous.value) * alpha;
  }

  return points[points.length - 1].value;
}
