import type { DieFace } from '../../contract/types';
import { type QuaternionLike, rotateVectorByQuat, type VectorTuple } from './simulation-math';

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
  return observeTopFace(q).face;
}

export function observeTopFace(q: QuaternionLike): { face: DieFace; alignment: number } {
  let best = FACE_BY_NORMAL[0];
  let bestY = -Infinity;
  let alignment = -Infinity;
  for (const face of FACE_BY_NORMAL) {
    const rotated = rotateVectorByQuat(face.n, q);
    alignment = Math.max(alignment, rotated[1]);
    if (rotated[1] > bestY) {
      bestY = rotated[1];
      best = face;
    }
  }
  return { face: best.value, alignment };
}

export function topFaceAlignment(q: QuaternionLike): number {
  return observeTopFace(q).alignment;
}
