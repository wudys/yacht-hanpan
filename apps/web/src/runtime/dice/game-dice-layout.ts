import type { DieFace, DieSlot, RollArea } from '@repo/dice-simulation/contract';

import { DICE_BOARD_LAYOUT } from '@/ui/layout/dice-board-layout';

export interface RollLayerPadding {
  extraX: number;
  extraTop: number;
  extraBottom: number;
}

export interface RollVisualInset {
  x: number;
  y: number;
}

export interface RollViewportSize {
  width: number;
  height: number;
}

export interface RollStageLayout {
  layerPadding: RollLayerPadding;
  visualInset: RollVisualInset;
}

export interface RollRenderFit {
  projectedRollAreaPx: {
    width: number;
    height: number;
  };
  worldPerPixel: number;
  cameraCenterZ: number;
}

export type SettledDie = Readonly<{
  slot: DieSlot;
  value: DieFace;
}>;

export type SettledDieLayout = Readonly<{
  slot: DieSlot;
  value: DieFace;
  position: [number, number, number];
  scale: number;
  centerPx: Readonly<{ x: number; y: number }>;
}>;

export const DICE_CANVAS_VIEWPORT_SIZE = {
  width: DICE_BOARD_LAYOUT.width,
  height: DICE_BOARD_LAYOUT.height,
} as const;

// The fixed world and visible inner surface share an aspect ratio. Viewport scaling
// never changes physics; a geometry regression check guards this adapter contract.
export const GAME_ROLL_LAYOUT: RollStageLayout = {
  layerPadding: {
    extraX: DICE_BOARD_LAYOUT.borderInset,
    extraTop: DICE_BOARD_LAYOUT.rackHeight,
    extraBottom: DICE_BOARD_LAYOUT.borderInset,
  },
  visualInset: { x: 0, y: 0 },
};

export function gamePhysicsAreaBounds(rollArea: RollArea) {
  const fit = computeRollFit({
    ...GAME_ROLL_LAYOUT,
    rollArea,
    size: DICE_CANVAS_VIEWPORT_SIZE,
  });
  const { width, height } = fit.projectedRollAreaPx;
  const centerZ = rollArea.centerZ ?? 1.23;
  return {
    left: (DICE_CANVAS_VIEWPORT_SIZE.width - width) / 2,
    top:
      (DICE_CANVAS_VIEWPORT_SIZE.height - height) / 2 +
      (centerZ - fit.cameraCenterZ) / fit.worldPerPixel,
    width,
    height,
  };
}

// Central UI arrangement uses its own non-physical camera space. Changing the tray
// must not silently change settled die size, pitch or the matching DOM hit targets.
export const SETTLED_STAGE_AREA: Readonly<RollArea> = Object.freeze({
  width: 5.44,
  depth: 2.9781,
  aspectRatio: 1.8266,
  centerZ: 1.4891,
  topZ: 0,
  bottomZ: 2.9781,
});

export const SETTLED_STAGE_LAYOUT: RollStageLayout = {
  layerPadding: { extraX: 16, extraTop: 0, extraBottom: 8 },
  visualInset: { x: 16, y: 16 },
};

export function computeRollFit({
  layerPadding,
  rollArea,
  size,
  visualInset,
}: {
  layerPadding: RollLayerPadding;
  rollArea: RollArea;
  size: RollViewportSize;
  visualInset: RollVisualInset;
}): RollRenderFit {
  const playfieldWidth = Math.max(1, size.width - layerPadding.extraX * 2);
  const playfieldHeight = Math.max(
    1,
    size.height - layerPadding.extraTop - layerPadding.extraBottom,
  );
  const fittedWidth = Math.max(1, playfieldWidth - visualInset.x * 2);
  const fittedHeight = Math.max(1, playfieldHeight - visualInset.y * 2);
  const worldPerPixel = Math.max(rollArea.width / fittedWidth, rollArea.depth / fittedHeight);
  const centerZ = rollArea.centerZ ?? 1.23;
  const verticalOffsetPx = (layerPadding.extraTop - layerPadding.extraBottom) / 2;
  const fittedRollAreaHeight = rollArea.depth / worldPerPixel;
  const bottomAnchorOffsetPx = Math.max(0, fittedHeight - fittedRollAreaHeight) / 2;

  return {
    projectedRollAreaPx: {
      width: rollArea.width / worldPerPixel,
      height: rollArea.depth / worldPerPixel,
    },
    worldPerPixel,
    cameraCenterZ: centerZ - (verticalOffsetPx + bottomAnchorOffsetPx) * worldPerPixel,
  };
}

const SETTLED_DIE_RENDER_SIZE = 0.95;
const SETTLED_DIE_SPACING = 1.1;

export function layoutSettledDice(
  dice: readonly SettledDie[],
  viewport: RollViewportSize,
): readonly SettledDieLayout[] {
  const fit = computeRollFit({
    ...SETTLED_STAGE_LAYOUT,
    rollArea: SETTLED_STAGE_AREA,
    size: viewport,
  });
  const centerZ = SETTLED_STAGE_AREA.centerZ ?? SETTLED_STAGE_AREA.depth / 2;

  return dice.map((die, index) => {
    const x = (index - (dice.length - 1) / 2) * SETTLED_DIE_SPACING;
    return {
      ...die,
      position: [x, 0, centerZ],
      scale: SETTLED_DIE_RENDER_SIZE,
      centerPx: {
        x: viewport.width / 2 + x / fit.worldPerPixel,
        y: viewport.height / 2 + (centerZ - fit.cameraCenterZ) / fit.worldPerPixel,
      },
    };
  });
}
