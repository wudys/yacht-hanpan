import type { DieFace } from '../../contract/types';

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

type FaceByNormal = {
  value: DieFace;
  n: VectorTuple;
};

const FACE_BY_NORMAL: FaceByNormal[] = [
  { value: 3, n: [1, 0, 0] },
  { value: 4, n: [-1, 0, 0] },
  { value: 1, n: [0, 1, 0] },
  { value: 6, n: [0, -1, 0] },
  { value: 2, n: [0, 0, 1] },
  { value: 5, n: [0, 0, -1] },
];

export function recognizeTopFace(q: QuaternionLike): DieFace {
  let best = FACE_BY_NORMAL[0];
  let bestY = -Infinity;
  for (const face of FACE_BY_NORMAL) {
    const rotated = rotateVectorByQuat(face.n, q);
    if (rotated[1] > bestY) {
      bestY = rotated[1];
      best = face;
    }
  }
  return best.value;
}

export function topFaceAlignment(q: QuaternionLike): number {
  return Math.max(...FACE_BY_NORMAL.map((face) => rotateVectorByQuat(face.n, q)[1]));
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
