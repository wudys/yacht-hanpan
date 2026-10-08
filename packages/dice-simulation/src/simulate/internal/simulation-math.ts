import type { Rotation } from '@dimforge/rapier3d-deterministic';

export type VectorTuple = [number, number, number];
export type QuaternionTuple = [number, number, number, number];
export type QuaternionLike =
  | QuaternionTuple
  | {
      x: number;
      y: number;
      z: number;
      w: number;
    };

export function quatDistance(a: QuaternionTuple, b: QuaternionTuple): number {
  const dot = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return 2 * Math.acos(dot);
}

export function normalizedQuatDistance(a: QuaternionTuple, b: QuaternionTuple): number {
  const dot =
    Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) /
    (Math.hypot(...a) * Math.hypot(...b));
  return 2 * Math.acos(Math.min(1, dot));
}

export function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function quatFromEuler(x: number, y: number, z: number): Rotation {
  const c1 = Math.cos(x / 2),
    c2 = Math.cos(y / 2),
    c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2),
    s2 = Math.sin(y / 2),
    s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  };
}

export function rotateVectorByQuat(v: VectorTuple, q: QuaternionLike): VectorTuple {
  const [qx, qy, qz, qw] = quaternionToTuple(q);
  const x = v[0],
    y = v[1],
    z = v[2];
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}

function quaternionToTuple(q: QuaternionLike): QuaternionTuple {
  if (Array.isArray(q)) return q;
  return [q.x, q.y, q.z, q.w];
}
