import type { DieFace, QuaternionTuple } from '@repo/dice-simulation/contract';

// Final UI poses match score-icons; physical replay keeps its recorded rotation.
export const TOP_FACE_QUATERNION: Readonly<Record<DieFace, QuaternionTuple>> = Object.freeze({
  1: [0, 0, 0, 1],
  2: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  3: [0.5, 0.5, 0.5, 0.5],
  4: [0, 0, -Math.SQRT1_2, Math.SQRT1_2],
  5: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  6: [1, 0, 0, 0],
});
