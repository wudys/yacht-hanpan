import { describe, expect, test } from 'bun:test';

import { type RollTimeline, TRAY_GEOMETRY } from '../contract';
import { DIE_SIZE, FLOOR_TOP_Y } from '../simulate/internal/roll-simulation-constants';
import type { PhysicsCompletionSnapshot } from '../simulate/simulate-physics';
import { measurePhysicsCompletion, physicsCompletionIssues } from './physical-roll-audit';

describe('physical completion audit', () => {
  test('reports a raw stack even when final timeline poses has separated the dice', () => {
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
    expect(report.facesPreserved).toBe(true);
    expect(report.rawMaxLinearSpeed).toBe(0);
    expect(physicsCompletionIssues(report)).toEqual(['stacked', 'lifted']);
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
    expect(physicsCompletionIssues(report)).toContain('changed-faces');
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
    expect(physicsCompletionIssues(report)).toEqual(['outside-tray', 'linear-speed']);
  });

  test.each([
    { name: 'readable resting die', height: 0, tilt: 0, issues: [] },
    { name: 'lifted readable die', height: DIE_SIZE, tilt: 0, issues: ['lifted'] },
    {
      name: 'resting at an unreadable tilt',
      height: 0,
      tilt: Math.PI / 6,
      issues: ['low-readability'],
    },
  ])(
    'classifies $name independently of preserved faces and final timeline pose drift',
    ({ height, tilt, issues }) => {
      const p: [number, number, number] = [0, FLOOR_TOP_Y + DIE_SIZE / 2 + height, 1];
      const q: [number, number, number, number] = [0, 0, Math.sin(tilt / 2), Math.cos(tilt / 2)];
      const raw: PhysicsCompletionSnapshot = {
        simulationMs: 100,
        dice: [{ slot: 0, frameIndex: 0, p, q, linearSpeed: 0, angularSpeed: 0 }],
      };
      const report = measurePhysicsCompletion(raw, [
        { slot: 0, value: 1, frames: [{ t: 100, p, q }] },
      ]);
      expect(report.facesPreserved).toBe(true);
      expect(report.translatedDice).toBe(0);
      expect(physicsCompletionIssues(report)).toEqual([...issues]);
    },
  );

  test.each([
    {
      name: 'both speeds below normal rest',
      linearSpeed: 0.045 - 1e-8,
      angularSpeed: 0.18 - 1e-8,
      issues: [],
    },
    {
      name: 'linear speed at normal rest boundary',
      linearSpeed: 0.045,
      angularSpeed: 0,
      issues: ['linear-speed'],
    },
    {
      name: 'angular speed at normal rest boundary',
      linearSpeed: 0,
      angularSpeed: 0.18,
      issues: ['angular-speed'],
    },
    {
      name: 'linear speed above normal rest but below the late cutoff',
      linearSpeed: 0.055,
      angularSpeed: 0,
      issues: ['linear-speed'],
    },
    {
      name: 'angular speed above normal rest but below the late cutoff',
      linearSpeed: 0,
      angularSpeed: 0.2,
      issues: ['angular-speed'],
    },
    {
      name: 'both speeds above normal rest',
      linearSpeed: 0.1,
      angularSpeed: 0.3,
      issues: ['linear-speed', 'angular-speed'],
    },
  ])(
    'flags $name despite readable unchanged final poses',
    ({ linearSpeed, angularSpeed, issues }) => {
      const p: [number, number, number] = [0, FLOOR_TOP_Y + DIE_SIZE / 2, 1];
      const q: [number, number, number, number] = [0, 0, 0, 1];
      const report = measurePhysicsCompletion(
        { simulationMs: 100, dice: [{ slot: 0, frameIndex: 0, p, q, linearSpeed, angularSpeed }] },
        [{ slot: 0, value: 1, frames: [{ t: 100, p, q }] }],
      );
      expect(report.facesPreserved).toBe(true);
      expect(report.rawLiftedDice).toBe(0);
      expect(report.rawLowReadabilityDice).toBe(0);
      expect(physicsCompletionIssues(report)).toEqual([...issues]);
    },
  );
});
