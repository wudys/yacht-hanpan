import { describe, expect, it } from 'bun:test';

import { createRollPhysicsConfig } from './roll-physics';

describe('shared roll physics', () => {
  it('uses dice-like physical energy without profile selection', () => {
    const config = createRollPhysicsConfig();

    expect(config.gravity).toBeLessThanOrEqual(-24.5);
    expect(config.gravity).toBeGreaterThanOrEqual(-29.5);
    expect(config.floorRestitution).toBeGreaterThanOrEqual(0.12);
    expect(config.floorRestitution).toBeLessThanOrEqual(0.19);
    // One shared contact material balances rolling grip and resting wedges.
    expect(config.floorFriction).toBe(0.25);
    expect(config.linearDamping).toBeLessThanOrEqual(0.038);
    expect(config.angularDamping).toBeLessThanOrEqual(0.058);
  });

  it('keeps caller changes isolated from later worlds', () => {
    const altered = createRollPhysicsConfig();
    const original = createRollPhysicsConfig();
    altered.gravity = 0;
    altered.floorFriction = 1;

    expect(createRollPhysicsConfig()).toEqual(original);
  });
});
