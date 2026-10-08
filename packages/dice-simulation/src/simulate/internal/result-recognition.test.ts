import { describe, expect, it } from 'bun:test';

import { recognizeTopFace } from './result-recognition';
import { type QuaternionTuple } from './simulation-math';

describe('dice result recognition', () => {
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
