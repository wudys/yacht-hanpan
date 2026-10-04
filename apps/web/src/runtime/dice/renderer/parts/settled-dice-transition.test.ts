import { DIE_GEOMETRY, ROLL_AREA } from '@repo/dice-simulation/contract';
import { describe, expect, test } from 'vitest';

import {
  computeRollFit,
  SETTLED_STAGE_AREA,
  SETTLED_STAGE_LAYOUT,
} from '@/runtime/dice/game-dice-layout';
import { projectPhysicalDieToSettled } from '@/runtime/dice/renderer/parts/settled-dice-transition';

describe('one physical-to-UI arrangement', () => {
  test('preserves screen position and size when changing camera spaces', () => {
    const size = { width: 340, height: 204 };
    const layout = {
      layerPadding: { extraX: 4, extraTop: 72, extraBottom: 4 },
      visualInset: { x: 0, y: 0 },
    };
    const frame = {
      t: 100,
      p: [2.8, -0.2, 2.4] as [number, number, number],
      q: [0, 0, 0, 1] as [number, number, number, number],
    };
    const source = computeRollFit({
      ...layout,
      rollArea: ROLL_AREA,
      size,
    });
    const destination = computeRollFit({
      ...SETTLED_STAGE_LAYOUT,
      rollArea: SETTLED_STAGE_AREA,
      size,
    });
    const projected = projectPhysicalDieToSettled(frame, ROLL_AREA, layout, size);
    expect(projected.position[0] / destination.worldPerPixel).toBeCloseTo(
      frame.p[0] / source.worldPerPixel,
      8,
    );
    expect(
      (projected.position[2] - destination.cameraCenterZ) / destination.worldPerPixel,
    ).toBeCloseTo((frame.p[2] - source.cameraCenterZ) / source.worldPerPixel, 8);
    expect(projected.scale / destination.worldPerPixel).toBeCloseTo(
      DIE_GEOMETRY.size / source.worldPerPixel,
      8,
    );
  });
});
