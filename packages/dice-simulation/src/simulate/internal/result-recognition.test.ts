import { describe, expect, it } from 'bun:test';

import { observeTopFace, recognizeTopFace, topFaceAlignment } from './result-recognition';
import { type QuaternionTuple, rotateVectorByQuat } from './simulation-math';

describe('dice result recognition', () => {
  it.each([
    [0, 0, 0, 1],
    [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)],
    [0.5, 0.5, 0.5, 0.5],
    [0.2, -0.3, 0.4, 0.7],
    [0, 0, 0, 0],
  ] as QuaternionTuple[])(
    'keeps ordered face ties and maximum alignment for (%s, %s, %s, %s)',
    (x, y, z, w) => {
      const q: QuaternionTuple = [x, y, z, w];
      const faces = [3, 4, 1, 6, 2, 5] as const;
      const normals: [number, number, number][] = [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ];
      const heights = normals.map((normal) => rotateVectorByQuat(normal, q)[1]);
      const alignment = Math.max(...heights);
      const face = faces[heights.indexOf(alignment)];
      expect(observeTopFace(q)).toEqual({ face, alignment });
      expect(recognizeTopFace(q)).toBe(face);
      expect(topFaceAlignment(q)).toBe(alignment);
    },
  );

  it('recognizes canonical display poses as their intended faces', () => {
    expect(
      (
        [
          [0, 0, 0, 1],
          [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
          [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          [0, 0, -Math.SQRT1_2, Math.SQRT1_2],
          [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
          [1, 0, 0, 0],
        ] as QuaternionTuple[]
      ).map(recognizeTopFace),
    ).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
