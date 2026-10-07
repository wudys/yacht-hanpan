export type RollPhysicsConfig = {
  gravity: number;
  floorRestitution: number;
  floorFriction: number;
  wallRestitution: number;
  wallFriction: number;
  linearDamping: number;
  angularDamping: number;
};

const BASE_PHYSICS = {
  gravity: -27.2,
  floorRestitution: 0.16,
  floorFriction: 0.25,
  wallRestitution: 0.5,
  wallFriction: 0.06,
  linearDamping: 0.025,
  angularDamping: 0.032,
};

/** A single tray material and gravity for every seed and die count. */
export function createRollPhysicsConfig(): RollPhysicsConfig {
  return { ...BASE_PHYSICS };
}
