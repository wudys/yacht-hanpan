import { describe, expect, test } from 'bun:test';

import { type RollTimeline, TRAY_GEOMETRY } from '../contract';
import { DIE_SIZE, FLOOR_TOP_Y } from '../simulate/internal/roll-simulation-constants';
import type { PhysicsCompletionSnapshot } from '../simulate/simulate-timeline';
import { measurePhysicsCompletion } from './physical-roll-audit';

describe('physical completion audit', () => {
  test('reports a raw stack even when final display correction has separated the dice', () => {
    const floor = FLOOR_TOP_Y + DIE_SIZE / 2;
    const raw: PhysicsCompletionSnapshot = {
      simulationMs: 1000,
      dice: [
        {
          slot: 0,
          frameIndex: 0,
          p: [0, floor, 1],
          q: [0, 0, 0, 1],
          linearSpeed: 0,
          angularSpeed: 0,
        },
        {
          slot: 3,
          frameIndex: 0,
          p: [0, floor + DIE_SIZE, 1],
          q: [0, 0, 0, 1],
          linearSpeed: 0,
          angularSpeed: 0,
        },
      ],
    };
    const dice: RollTimeline['dice'] = raw.dice.map((die) => ({
      slot: die.slot,
      value: 1,
      frames: [
        { t: 900, p: die.p, q: die.q },
        { t: 1100, p: [die.slot === 0 ? 0 : DIE_SIZE * 1.2, floor, 1], q: die.q },
      ],
    }));
    const report = measurePhysicsCompletion(raw, dice);

    expect(report.rawStackedPairs).toBe(1);
    expect(report.rawLiftedDice).toBe(1);
    expect(report.translatedDice).toBe(1);
    expect(report.maxPlanarCorrectionDieWidths).toBeCloseTo(1.2);
    expect(report.displayCorrectionMs).toBe(200);
    expect(report.facesPreserved).toBe(true);
    expect(report.rawMaxLinearSpeed).toBe(0);
  });

  test('detects changed faces independently of a visually aligned final pose', () => {
    const raw: PhysicsCompletionSnapshot = {
      simulationMs: 100,
      dice: [
        {
          slot: 4,
          frameIndex: 0,
          p: [0, 0, 0],
          q: [0, 0, 0, 1],
          linearSpeed: 0.1,
          angularSpeed: 0.2,
        },
      ],
    };
    const report = measurePhysicsCompletion(raw, [
      {
        slot: 4,
        value: 1,
        frames: [
          { t: 100, p: [0, 0, 0], q: [0, 0, 0, 1] },
          { t: 220, p: [0, 0, 0], q: [1, 0, 0, 0] },
        ],
      },
    ]);

    expect(report.facesPreserved).toBe(false);
    expect(report.maxAngularCorrectionRadians).toBeCloseTo(Math.PI);
    expect(report.rawMaxLinearSpeed).toBe(0.1);
    expect(report.rawMaxAngularSpeed).toBe(0.2);
  });

  test('reports an escaped die even when its top face is readable', () => {
    const p = [TRAY_GEOMETRY.halfWidth + 1, FLOOR_TOP_Y - 2, 1] as const;
    const q = [0, 0, 0, 1] as const;
    const report = measurePhysicsCompletion(
      {
        simulationMs: 100,
        dice: [{ slot: 0, frameIndex: 0, p: [...p], q: [...q], linearSpeed: 4, angularSpeed: 0 }],
      },
      [{ slot: 0, value: 1, frames: [{ t: 100, p: [...p], q: [...q] }] }],
    );
    expect(report.rawOutsideTrayDice).toBe(1);
    expect(report.rawLowReadabilityDice).toBe(0);
  });
});
