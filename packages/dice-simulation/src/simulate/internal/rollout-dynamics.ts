import type { PhysicsDie } from './physics-environment';
import { interpolateMotionCap, limitPlanarVelocity } from './rollout-motion';

const ROLLOUT_X_CAPS = [
  { t: 0, value: 3.3 },
  { t: 0.18, value: 5.0 },
  { t: 0.45, value: 4.5 },
  { t: 1.1, value: 3.4 },
  { t: 2.2, value: 2.1 },
];
const ROLLOUT_Z_CAPS = [
  { t: 0, value: 3.1 },
  { t: 0.18, value: 4.5 },
  { t: 0.45, value: 4.0 },
  { t: 1.1, value: 3.1 },
  { t: 2.2, value: 2.0 },
];
const ROLLOUT_ANGULAR_CAPS = [
  { t: 0, value: 14 },
  { t: 0.16, value: 12.2 },
  { t: 0.45, value: 11.2 },
];

export function constrainRolloutVelocity(dice: PhysicsDie[], elapsedSeconds: number): void {
  if (elapsedSeconds > 3.4) return;

  const { maxXSpeed, maxZSpeed } = rolloutSpeedCaps(elapsedSeconds);
  dice.forEach((die) => {
    const velocity = die.body.linvel();
    const planar = limitPlanarVelocity(
      { x: velocity.x, z: velocity.z },
      { maxX: maxXSpeed, maxZ: maxZSpeed },
    );
    die.body.setLinvel(
      {
        x: planar.x,
        // Keep gravity and vertical impacts physical; a fall-speed cap prolongs
        // crowded contacts and can leave dice balanced against one another.
        y: velocity.y,
        z: planar.z,
      },
      true,
    );
  });
}

function rolloutSpeedCaps(elapsedSeconds: number): { maxXSpeed: number; maxZSpeed: number } {
  return {
    maxXSpeed: interpolateMotionCap(elapsedSeconds, ROLLOUT_X_CAPS),
    maxZSpeed: interpolateMotionCap(elapsedSeconds, ROLLOUT_Z_CAPS),
  };
}

export function constrainRolloutAngularVelocity(dice: PhysicsDie[], elapsedSeconds: number): void {
  if (elapsedSeconds > 0.9) return;

  dice.forEach((die) => {
    const linearVelocity = die.body.linvel();
    const velocity = die.body.angvel();
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    const planarSpeed = Math.hypot(linearVelocity.x, linearVelocity.z);
    const maxAngularSpeed = rolloutAngularSpeedCap(elapsedSeconds, planarSpeed);
    if (speed <= maxAngularSpeed) return;
    const scale = maxAngularSpeed / speed;
    die.body.setAngvel(
      {
        x: velocity.x * scale,
        y: velocity.y * scale,
        z: velocity.z * scale,
      },
      true,
    );
  });
}

function rolloutAngularSpeedCap(elapsedSeconds: number, planarSpeed: number): number {
  const angularSpeedCeiling = interpolateMotionCap(elapsedSeconds, ROLLOUT_ANGULAR_CAPS);
  const coupledCap = 5.8 + planarSpeed * 2.75;
  return Math.min(angularSpeedCeiling, coupledCap);
}
