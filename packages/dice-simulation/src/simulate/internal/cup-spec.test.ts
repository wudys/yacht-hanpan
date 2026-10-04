import { describe, expect, it } from 'bun:test';

import { cupInteriorMeta, DEFAULT_CUP_SPEC } from './cup-spec';

describe('cup spec', () => {
  it('derives the visible and physical interior from one spec', () => {
    expect(cupInteriorMeta(DEFAULT_CUP_SPEC)).toEqual({
      innerWidth: DEFAULT_CUP_SPEC.innerRadius * 2,
      innerDepth: DEFAULT_CUP_SPEC.innerRadius * 2,
      innerHeight: 2,
    });
  });
});
