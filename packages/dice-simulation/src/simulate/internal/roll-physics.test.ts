import { describe, expect, it } from 'bun:test';

import { createRollPhysicsConfig } from './roll-physics';

describe('shared roll physics', () => {
  it('keeps caller changes isolated from later worlds', () => {
    const altered = createRollPhysicsConfig();
    const original = createRollPhysicsConfig();
    altered.gravity = 0;
    altered.floorFriction = 1;

    expect(createRollPhysicsConfig()).toEqual(original);
  });
});
