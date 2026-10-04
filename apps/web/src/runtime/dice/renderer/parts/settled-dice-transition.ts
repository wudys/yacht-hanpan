import {
  DIE_GEOMETRY,
  type DieFrame,
  type RollArea,
  TRAY_FLOOR_TOP_Y,
} from '@repo/dice-simulation/contract';

import {
  computeRollFit,
  type RollStageLayout,
  type RollViewportSize,
  SETTLED_STAGE_AREA,
  SETTLED_STAGE_LAYOUT,
} from '@/runtime/dice/game-dice-layout';

export function projectPhysicalDieToSettled(
  frame: DieFrame,
  rollArea: RollArea,
  layout: RollStageLayout,
  size: RollViewportSize,
): Readonly<{ position: [number, number, number]; scale: number }> {
  const from = computeRollFit({
    ...layout,
    rollArea,
    size,
  });
  const to = computeRollFit({
    ...SETTLED_STAGE_LAYOUT,
    rollArea: SETTLED_STAGE_AREA,
    size,
  });
  const ratio = to.worldPerPixel / from.worldPerPixel;
  return {
    position: [
      frame.p[0] * ratio,
      TRAY_FLOOR_TOP_Y + (frame.p[1] - TRAY_FLOOR_TOP_Y) * ratio,
      to.cameraCenterZ + (frame.p[2] - from.cameraCenterZ) * ratio,
    ],
    scale: DIE_GEOMETRY.size * ratio,
  };
}
