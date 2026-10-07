import { DICE_SIMULATION_CONTRACT } from '../../contract/constants';
import {
  DIE_GEOMETRY,
  ROLL_AREA,
  TRAY_FLOOR_TOP_Y,
  TRAY_GEOMETRY,
} from '../../contract/roll-geometry';

export const STEP = DICE_SIMULATION_CONTRACT.fixedStepSeconds;
export const SAMPLE_FPS = 30;
export const DIE_SIZE = DIE_GEOMETRY.size;
export const DIE_COLLIDER_RADIUS = DIE_GEOMETRY.colliderRadius;
export const FLOOR_Y = TRAY_GEOMETRY.floorY;
export const FLOOR_TOP_Y = TRAY_FLOOR_TOP_Y;

export const trayGeometry = TRAY_GEOMETRY;

export function rollAreaMeta() {
  return { ...ROLL_AREA };
}

/** Display recording interval; physical handoff keeps its own cadence. */
export function timelineSampleEverySteps(): number {
  return Math.max(1, Math.round(1 / STEP / SAMPLE_FPS));
}
