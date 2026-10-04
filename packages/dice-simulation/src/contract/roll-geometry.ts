import type { RollArea } from './types';

/** Versioned world units shared by authority, replay and rendering. Never viewport input. */
const DIE_EDGE = (0.74455 * 28) / 32;
export const DIE_GEOMETRY = Object.freeze({ size: DIE_EDGE, colliderRadius: DIE_EDGE * 0.16 });

export const TRAY_GEOMETRY = Object.freeze({
  // Match the product's 332×128 inner surface without compressing cup depth.
  halfWidth: 3.86235,
  topZ: 0,
  bottomZ: 2.9782,
  centerZ: 1.4891,
  halfDepth: 1.4891,
  bottomCornerRadius: 0.1861,
  wallHalfHeight: 2.95,
  wallCenterY: 2.35,
  // Keep the complete tilted cup/release arc below the ceiling, not on its roof.
  ceilingY: 5.58,
  ceilingHalfHeight: 0.28,
  wallThickness: 0.78,
  floorY: -0.76,
  floorHalfHeight: 0.18,
});

const round = (value: number) => Math.round(value * 10000) / 10000;

export const ROLL_AREA: Readonly<RollArea> = Object.freeze({
  width: round(TRAY_GEOMETRY.halfWidth * 2),
  depth: round(TRAY_GEOMETRY.halfDepth * 2),
  aspectRatio: round(TRAY_GEOMETRY.halfWidth / TRAY_GEOMETRY.halfDepth),
  centerZ: TRAY_GEOMETRY.centerZ,
  topZ: TRAY_GEOMETRY.topZ,
  bottomZ: TRAY_GEOMETRY.bottomZ,
});

export const TRAY_FLOOR_TOP_Y = TRAY_GEOMETRY.floorY + TRAY_GEOMETRY.floorHalfHeight;
