import { describe, expect, test } from 'bun:test';

import {
  DICE_SIMULATION_CONTRACT,
  parseSimulationInput,
  POUR_STYLE,
  type SimulationInput,
  SimulationInputError,
} from './index';

type ForbiddenInputKey = Extract<
  keyof SimulationInput,
  | 'authoritativeValuesBySlot'
  | 'diceCount'
  | 'heldDice'
  | 'outcome'
  | 'targetFace'
  | 'targetFaces'
  | 'targetValues'
  | 'timeline'
  | 'values'
>;

const noForbiddenInputKeys: ForbiddenInputKey extends never ? true : false = true;

const validInput = {
  rollId: 'roll-1',
  seed: 'seed-1',
  rolledSlots: [0, 2, 4],
  pourStyle: POUR_STYLE.CLASSIC,
} as const;

describe('dice simulation contract', () => {
  test('keeps independent runtime and artifact versions', () => {
    expect(DICE_SIMULATION_CONTRACT).toEqual({
      simulationVersion: 'dice-simulation-v36',
      timelineSchemaVersion: 'dice-timeline-v4',
      replayDigestVersion: 'sha256-q4-v2',
      prngVersion: 'sha256-counter53-v1',
      physicsRuntime: '@dimforge/rapier3d-deterministic@0.19.3',
      fixedStepSeconds: 1 / 60,
    });
  });

  test('cannot accept authoritative outcomes or target faces as input keys', () => {
    expect(noForbiddenInputKeys).toBe(true);
  });

  test('parses exact input and derives dice count from slot identity', () => {
    const parsed = parseSimulationInput(validInput);
    expect(parsed).toEqual(validInput);
    expect(parsed.rolledSlots).toEqual([0, 2, 4]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.rolledSlots)).toBe(true);
  });

  test.each([
    [{ ...validInput, values: [6, 6, 6] }],
    [{ ...validInput, targetFaces: [6, 6, 6] }],
    [{ ...validInput, timeline: [] }],
    [{ ...validInput, diceCount: 3 }],
    [{ ...validInput, heldDice: [1] }],
    [{ ...validInput, rolledSlots: [] }],
    [{ ...validInput, rolledSlots: [0, 1, 2, 3, 4, 5] }],
    [{ ...validInput, rolledSlots: [0, 0] }],
    [{ ...validInput, rolledSlots: [2, 1] }],
    [{ ...validInput, rolledSlots: [0, 5] }],
    [{ ...validInput, rolledSlots: [0.5] }],
    [{ ...validInput, rolledSlots: Array(1) }],
    [{ ...validInput, rolledSlots: Object.assign(Array(3), { 0: 0, 2: 4 }) }],
    [{ ...validInput, rolledSlots: Object.assign(Array(2), { 0: 0 }) }],
    [{ ...validInput, rolledSlots: [undefined] }],
    [{ ...validInput, rollId: '' }],
    [{ ...validInput, rollId: ' roll-1' }],
    [{ ...validInput, seed: '' }],
    [{ ...validInput, seed: 'seed-1 ' }],
    [{ ...validInput, pourStyle: 'unknown' }],
    [{ ...validInput, pourStyle: 'toss' }],
    [{ ...validInput, pourStyle: 'ricochet' }],
  ])('rejects invalid or non-canonical input %#', (input) => {
    expect(() => parseSimulationInput(input)).toThrow(SimulationInputError);
  });

  test('accepts every valid dice count and pour style', () => {
    const styles = Object.values(POUR_STYLE);
    for (const pourStyle of styles) {
      for (let diceCount = 1; diceCount <= 5; diceCount += 1) {
        expect(
          parseSimulationInput({
            ...validInput,
            pourStyle,
            rolledSlots: [0, 1, 2, 3, 4].slice(0, diceCount),
          }).rolledSlots,
        ).toHaveLength(diceCount);
      }
    }
  });
});
