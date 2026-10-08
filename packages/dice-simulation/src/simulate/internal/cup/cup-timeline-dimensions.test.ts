import { describe, expect, it } from 'bun:test';

import { DEFAULT_CUP_GEOMETRY } from '../../../contract/cup-geometry';
import { cupInteriorDimensions } from './cup-timeline-dimensions';

describe('cup timeline dimensions', () => {
  it('derives timeline interior metadata from the shared cup geometry', () => {
    expect(cupInteriorDimensions(DEFAULT_CUP_GEOMETRY)).toEqual({
      innerWidth: DEFAULT_CUP_GEOMETRY.innerRadius * 2,
      innerDepth: DEFAULT_CUP_GEOMETRY.innerRadius * 2,
      innerHeight: 2,
    });
  });
});
