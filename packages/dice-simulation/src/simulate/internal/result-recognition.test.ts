import { describe, expect, it } from 'bun:test';

import { type QuaternionTuple, recognizeTopFace } from './result-recognition';

describe('dice result recognition', () => {
  it('recognizes the identity quaternion as face 1', () => {
    expect(recognizeTopFace([0, 0, 0, 1])).toBe(1);
  });

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
