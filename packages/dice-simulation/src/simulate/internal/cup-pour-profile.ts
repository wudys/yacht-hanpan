import { DEFAULT_CUP_GEOMETRY } from '../../contract/cup-geometry';
import type { RollArea } from '../../contract/types';
import { seededNumber } from './seed-expander';

export type CupPourProfile = {
  stageX: number;
  releaseX: number;
  side: -1 | 1;
};

export function createCupPourProfile(
  seed: string,
  rollArea: Pick<RollArea, 'width'>,
): CupPourProfile {
  // Preserve the alternating sides of the original six seed buckets.
  const directionBucket = Math.floor(seededNumber(`${seed}:cup-direction`, 0) * 6) % 6;
  const halfWidth = rollArea.width / 2;
  const side = directionBucket % 2 === 0 ? 1 : -1;
  // Reserve the shell and shake/tilt sweep inside the visible side wall. Enlarging
  // the tray must not proportionally move a fixed-size cup through the frame edge.
  const cupSideClearance =
    Math.hypot(
      DEFAULT_CUP_GEOMETRY.innerHeight / 2 + DEFAULT_CUP_GEOMETRY.baseThickness,
      DEFAULT_CUP_GEOMETRY.innerRadius + DEFAULT_CUP_GEOMETRY.wallThickness,
    ) + 0.12;
  const maxCupCenterX = Math.max(0, halfWidth - cupSideClearance);
  const releaseX = side * Math.max(0, Math.min(maxCupCenterX, 2.05) - 0.3);
  const stageX = side * Math.min(maxCupCenterX, 2.05);

  return {
    stageX: round(stageX),
    releaseX: round(releaseX),
    side,
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
