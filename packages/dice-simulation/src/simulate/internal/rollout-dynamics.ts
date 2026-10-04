import type { SimDie } from './physics-environment';
import { interpolateMotionCap, limitPlanarVelocity } from './rollout-motion';

export function constrainRolloutVelocity(dice: SimDie[], elapsedSeconds: number): void {
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
  return speedCaps(elapsedSeconds, [3.3, 5.0, 4.5, 3.4, 2.1], [3.1, 4.5, 4.0, 3.1, 2.0]);
}

function speedCaps(
  elapsedSeconds: number,
  xCaps: number[],
  zCaps: number[],
): { maxXSpeed: number; maxZSpeed: number } {
  const times = [0, 0.18, 0.45, 1.1, 2.2];
  return {
    maxXSpeed: interpolateMotionCap(
      elapsedSeconds,
      times.map((t, index) => ({ t, value: xCaps[index] })),
    ),
    maxZSpeed: interpolateMotionCap(
      elapsedSeconds,
      times.map((t, index) => ({ t, value: zCaps[index] })),
    ),
  };
}

export function constrainRolloutAngularVelocity(dice: SimDie[], elapsedSeconds: number): void {
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
  const styleCeiling = interpolateMotionCap(elapsedSeconds, [
    { t: 0, value: 14 },
    { t: 0.16, value: 12.2 },
    { t: 0.45, value: 11.2 },
  ]);
  const coupledCap = 5.8 + planarSpeed * 2.75;
  return Math.min(styleCeiling, coupledCap);
}
