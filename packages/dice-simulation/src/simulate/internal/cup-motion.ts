import { CUP_EXIT_HOLD_MS, type CupFrame, type PourStyle } from '../../contract';
import { cupLowerSupport } from '../../contract/cup-geometry';
import { TRAY_FLOOR_TOP_Y } from '../../contract/roll-geometry';
import { CUP_EXIT_TAIL_MS, CUP_GATHER_MS, cupPourProgress } from './cup-motion-progress';
import { createCupPourProfile } from './cup-pour-profile';
import { rollAreaMeta, trayGeometry } from './roll-simulation-constants';
import { seededNumber } from './seed-expander';
import { quatFromEuler, round } from './simulation-math';

export interface CupTransform {
  x: number;
  y: number;
  z: number;
  tilt: number;
  yaw: number;
}

export type SimulatedCupMotion = {
  style: PourStyle;
  shakeAmplitude: number;
  shakeFrequency: number;
  pourAtMs: number;
  stageX: number;
  stageZ: number;
  releaseX: number;
  releaseZ: number;
  tilt: number;
  pourDurationMs: number;
  pourTravelDurationMs: number;
  pourTravelDelayMs: number;
  pourFloorClearance: number;
  pourYaw: number;
  heightOffset: number;
  pourAssistDelayMs: number;
  releaseAtMs: number;
  exitAtMs: number;
};

export function createCupMotion(seed: string, style: PourStyle): SimulatedCupMotion {
  const profile = createCupPourProfile(seed, rollAreaMeta());
  const { side } = profile;
  // All three gestures share the selected shake, then gather for 80ms.
  const pourAtMs =
    Math.round(700 + 150 * seededNumber(`${seed}:shake-duration`, 0)) + CUP_GATHER_MS;
  // An upper bound until the physics loop observes every die outside the mouth.
  const releaseAtMs = pourAtMs + 3000;
  return {
    style,
    shakeAmplitude: 1,
    shakeFrequency: 20,
    pourAtMs,
    pourDurationMs: 400,
    // Assistance timing is independent of the selected tilt duration.
    pourAssistDelayMs: 300,
    pourTravelDurationMs: 500,
    pourTravelDelayMs: 0,
    pourFloorClearance: 1.85,
    pourYaw: 0,
    // Burst retains its raised clearance so dice can separate during release.
    heightOffset:
      (style === 'burst' ? 0.25 : 0) +
      (style === 'classic' ? 0 : style === 'burst' ? 0.443053 : 0.369182),
    releaseAtMs,
    exitAtMs: releaseAtMs + CUP_EXIT_HOLD_MS + CUP_EXIT_TAIL_MS,
    stageX: profile.stageX,
    stageZ: trayGeometry.centerZ,
    releaseX: profile.releaseX,
    releaseZ: trayGeometry.centerZ,
    tilt: side * (((style === 'classic' ? 155 : 135) * Math.PI) / 180),
  };
}

export function cupTransformAt(cup: SimulatedCupMotion, timeMs: number): CupTransform {
  const shakeEnd = cup.pourAtMs - CUP_GATHER_MS;
  const motionTime =
    timeMs < shakeEnd ? timeMs : timeMs < cup.pourAtMs ? shakeEnd : timeMs - CUP_GATHER_MS;
  // Gathering freezes the shake clock; later motion retains that same offset.
  const motionReleaseAtMs = cup.releaseAtMs - CUP_GATHER_MS;
  const motionExitAtMs = cup.exitAtMs - CUP_GATHER_MS;
  // Rotation timing is independent of observed empty time. Updating releaseAtMs
  // must never retroactively change the cup's path or replay frames.
  const pourProgress = smoothstep(
    cupPourProgress(motionTime, shakeEnd, shakeEnd + cup.pourDurationMs),
  );
  const withdrawProgress = smoothstep((motionTime - motionReleaseAtMs) / CUP_EXIT_HOLD_MS);
  const travelAtMs = shakeEnd + cup.pourTravelDelayMs;
  const travelProgress = smoothstep(
    cupPourProgress(motionTime, travelAtMs, travelAtMs + cup.pourTravelDurationMs),
  );
  const envelope =
    smoothstep(motionTime / 90) *
    (1 - smoothstep((motionTime / shakeEnd - 0.65) / 0.35)) *
    cup.shakeAmplitude;
  const seconds = motionTime / 1000;
  const x =
    cup.stageX +
    (cup.releaseX - cup.stageX) * travelProgress +
    Math.sin(seconds * cup.shakeFrequency) * 0.25 * envelope +
    Math.sign(cup.tilt) * 0.65 * withdrawProgress;
  const z =
    cup.stageZ +
    (cup.releaseZ - cup.stageZ) * pourProgress +
    Math.sin(seconds * 15.833333333333334) * 0.13 * envelope;
  if (timeMs < cup.pourAtMs) {
    const baseTilt =
      cup.tilt * pourProgress + ((Math.sign(cup.tilt) * Math.PI) / 2 - cup.tilt) * withdrawProgress;
    const exitProgress = smoothstep(
      (motionTime - motionReleaseAtMs) / (motionExitAtMs - motionReleaseAtMs),
    );
    return {
      x,
      y:
        TRAY_FLOOR_TOP_Y +
        cupLowerSupport(baseTilt) +
        cup.pourFloorClearance +
        exitProgress * 0.12 +
        Math.sin(seconds * cup.shakeFrequency) * 0.14 * envelope +
        cup.heightOffset,
      z,
      tilt: baseTilt + Math.sin(seconds * 17.5) * 0.22 * envelope,
      yaw: 0,
    };
  }
  const elapsed = timeMs - cup.pourAtMs;
  const withdraw = smoothstep((timeMs - cup.releaseAtMs) / CUP_EXIT_HOLD_MS);
  const exit = smoothstep((timeMs - cup.releaseAtMs) / (cup.exitAtMs - cup.releaseAtMs));
  // Burst opens to 120° then gently finishes the remaining 15°. Both joins
  // have zero angular velocity; classic and oblique use one smooth tilt.
  const angle =
    cup.style === 'burst'
      ? elapsed < 260
        ? ((120 * Math.PI) / 180) * smoothstep(elapsed / 260)
        : ((120 +
            ((Math.abs(cup.tilt) * 180) / Math.PI - 120) * smoothstep((elapsed - 260) / 140)) *
            Math.PI) /
          180
      : Math.abs(cup.tilt) * smoothstep(elapsed / cup.pourDurationMs);
  const tilt =
    Math.sign(cup.tilt) * angle + ((Math.sign(cup.tilt) * Math.PI) / 2 - cup.tilt) * withdraw;
  const yaw = cup.pourYaw * smoothstep(elapsed / cup.pourDurationMs);
  // Lift by 0.55 die edges over 280ms, independently of tilt. Following the
  // lowest rotating corner would reverse vertical velocity near 90°.
  const lift = Math.min(1, Math.max(0, elapsed / 280));
  const y =
    TRAY_FLOOR_TOP_Y +
    cupLowerSupport(0) +
    cup.pourFloorClearance +
    cup.heightOffset +
    0.3588067968299309 * (6 * lift ** 5 - 15 * lift ** 4 + 10 * lift ** 3) +
    exit * 0.12 +
    (timeMs > cup.releaseAtMs ? cupLowerSupport(tilt) - cupLowerSupport(cup.tilt) : 0);
  return { x, y, z, tilt, yaw };
}

function smoothstep(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

export function createCupFrame(cup: SimulatedCupMotion, timeMs: number): CupFrame {
  const transform = cupTransformAt(cup, timeMs);
  const mode = timeMs < cup.pourAtMs ? 'shake' : timeMs < cup.releaseAtMs ? 'pour' : 'exit';
  const { tilt, yaw } = transform;
  const q = quatFromEuler(0, yaw, tilt);
  return {
    t: timeMs,
    p: [round(transform.x), round(transform.y), round(transform.z)],
    q: [round(q.x), round(q.y), round(q.z), round(q.w)],
    visible: timeMs < cup.exitAtMs,
    mode,
  };
}
