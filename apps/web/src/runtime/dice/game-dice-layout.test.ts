import { DIE_GEOMETRY, ROLL_AREA, TRAY_GEOMETRY } from '@repo/dice-simulation/contract';
import { expect, test } from 'vitest';

import {
  computeRollFit,
  DICE_CANVAS_VIEWPORT_SIZE,
  gamePhysicsAreaBounds,
  layoutSettledDice,
  SETTLED_STAGE_AREA,
  SETTLED_STAGE_LAYOUT,
} from '@/runtime/dice/game-dice-layout';
import { DICE_BOARD_LAYOUT } from '@/ui/layout/dice-board-layout';

const INSET_LAYOUT = {
  layerPadding: { extraX: 16, extraTop: 0, extraBottom: 8 },
  visualInset: { x: 18, y: 18 },
};
const HIT_TARGET_SIZE = 44;

test('uses the full visible inner tray below the rack without changing viewport physics', () => {
  const bounds = gamePhysicsAreaBounds(ROLL_AREA);
  expect(bounds.left).toBeCloseTo(4, 2);
  expect(bounds.top).toBeCloseTo(72, 2);
  expect(bounds.width).toBeCloseTo(332, 2);
  expect(bounds.height).toBeCloseTo(128, 2);
  const worldPerPixel = ROLL_AREA.width / bounds.width;
  expect(TRAY_GEOMETRY.bottomCornerRadius / worldPerPixel).toBeCloseTo(
    DICE_BOARD_LAYOUT.cornerRadius - DICE_BOARD_LAYOUT.borderInset,
    2,
  );
});

test('fits the roll area inside padding and visual inset while preserving its aspect', () => {
  const size = { width: 460, height: 181 };
  const fit = computeRollFit({ ...INSET_LAYOUT, rollArea: SETTLED_STAGE_AREA, size });
  const { layerPadding, visualInset } = INSET_LAYOUT;
  const availableWidth = size.width - 2 * (layerPadding.extraX + visualInset.x);
  const availableHeight =
    size.height - layerPadding.extraTop - layerPadding.extraBottom - 2 * visualInset.y;

  expect(fit.projectedRollAreaPx.width).toBeLessThanOrEqual(availableWidth);
  expect(fit.projectedRollAreaPx.height).toBeCloseTo(availableHeight, 6);
  expect(fit.projectedRollAreaPx.width / fit.projectedRollAreaPx.height).toBeCloseTo(
    SETTLED_STAGE_AREA.width / SETTLED_STAGE_AREA.depth,
    10,
  );
});

test('keeps inset rolling dice legible and vertically centered', () => {
  const fit = computeRollFit({
    ...INSET_LAYOUT,
    rollArea: SETTLED_STAGE_AREA,
    size: { width: 350, height: 182 },
  });

  expect(DIE_GEOMETRY.size / fit.worldPerPixel).toBeGreaterThan(24);
  expect(fit.cameraCenterZ).toBeGreaterThan(SETTLED_STAGE_AREA.centerZ!);
});

test('reserves enough inset for a physical die touching a roll-area edge', () => {
  const fit = computeRollFit({
    ...INSET_LAYOUT,
    rollArea: SETTLED_STAGE_AREA,
    size: { width: 460, height: 181 },
  });
  const dieRadiusPx = DIE_GEOMETRY.size / 2 / fit.worldPerPixel;

  expect(INSET_LAYOUT.visualInset.x).toBeGreaterThanOrEqual(dieRadiusPx);
  expect(INSET_LAYOUT.visualInset.y).toBeGreaterThanOrEqual(dieRadiusPx);
});

test('centers the settled row while preserving nonconsecutive slot and face identity', () => {
  const dice = [
    { slot: 4, value: 6 },
    { slot: 1, value: 2 },
    { slot: 3, value: 5 },
  ] as const;
  const viewport = { width: 350, height: 182 };
  const layout = layoutSettledDice(dice, viewport);

  expect(layout.map(({ slot, value }) => ({ slot, value }))).toEqual(dice);
  expect((layout[0]!.centerPx.x + layout.at(-1)!.centerPx.x) / 2).toBe(viewport.width / 2);
  expect(new Set(layout.map(({ centerPx }) => centerPx.y)).size).toBe(1);
  expect(layout[0]!.centerPx.x - HIT_TARGET_SIZE / 2).toBeGreaterThanOrEqual(0);
  expect(layout.at(-1)!.centerPx.x + HIT_TARGET_SIZE / 2).toBeLessThanOrEqual(viewport.width);
  for (let index = 1; index < layout.length; index += 1) {
    expect(layout[index]!.centerPx.x - layout[index - 1]!.centerPx.x).toBeGreaterThanOrEqual(
      HIT_TARGET_SIZE,
    );
  }
});

test('keeps one to five settled meshes and hit targets separated inside the central band', () => {
  const dice = [
    { slot: 0, value: 1 },
    { slot: 1, value: 2 },
    { slot: 2, value: 3 },
    { slot: 3, value: 4 },
    { slot: 4, value: 5 },
  ] as const;
  const viewport = DICE_CANVAS_VIEWPORT_SIZE;
  const fit = computeRollFit({
    ...SETTLED_STAGE_LAYOUT,
    rollArea: SETTLED_STAGE_AREA,
    size: viewport,
  });
  for (let count = 1; count <= dice.length; count += 1) {
    const layout = layoutSettledDice(dice.slice(0, count), viewport);
    for (const [index, die] of layout.entries()) {
      const renderedSize = die.scale / fit.worldPerPixel;
      expect(renderedSize).toBeGreaterThanOrEqual(HIT_TARGET_SIZE);
      const halfExtent = Math.max(renderedSize, HIT_TARGET_SIZE) / 2;
      expect(die.centerPx.x - halfExtent).toBeGreaterThanOrEqual(0);
      expect(die.centerPx.x + halfExtent).toBeLessThanOrEqual(viewport.width);
      expect(die.centerPx.y - halfExtent).toBeGreaterThanOrEqual(DICE_BOARD_LAYOUT.rackHeight);
      expect(die.centerPx.y + halfExtent).toBeLessThanOrEqual(138);
      if (index === 0) continue;
      const previous = layout[index - 1]!;
      const pitch = die.centerPx.x - previous.centerPx.x;
      expect(pitch - HIT_TARGET_SIZE).toBeGreaterThanOrEqual(11.5);
      expect(pitch).toBeGreaterThan((die.scale + previous.scale) / 2 / fit.worldPerPixel);
    }
  }
});
