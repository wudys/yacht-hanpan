import { describe, expect, test } from 'bun:test';

import { isSimulationOutcome, isSimulationResult, type SimulationResult } from './index';

const result: SimulationResult = {
  input: { rollId: 'roll', seed: 'seed', rolledSlots: [2], pourStyle: 'classic' },
  timeline: {
    rollId: 'roll',
    seed: 'seed',
    durationMs: 100,
    cup: {
      style: 'classic',
      shakeAmplitude: 1,
      shakeFrequency: 24,
      pourAtMs: 10,
      releaseAtMs: 50,
      exitAtMs: 75,
      innerWidth: 1,
      innerDepth: 1,
      innerHeight: 2,
      frames: [{ t: 0, p: [0, 1, 0], q: [0, 0, 0, 1], visible: true, mode: 'shake' }],
    },
    rollArea: { width: 6, depth: 4, aspectRatio: 1.5 },
    dice: [{ slot: 2, value: 6, frames: [{ t: 100, p: [0, 0, 0], q: [0, 0, 0, 1] }] }],
  },
  authoritativeValuesBySlot: [{ slot: 2, value: 6 }],
  replayDigest: 'shape-only',
};

function changed(path: string, value: unknown): unknown {
  const copy = structuredClone(result);
  const keys = path.split('.');
  let parent = copy as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[keys.at(-1)!] = value;
  return copy;
}

describe('simulation result shape', () => {
  test('accepts the result without copying or mutating it', () => {
    const original = structuredClone(result);
    expect(isSimulationResult(result)).toBe(true);
    expect(result).toEqual(original);
  });

  test.each([
    ['input.extra', true],
    ['extra', true],
    ['timeline.extra', true],
    ['timeline.rollArea.extra', true],
    ['timeline.dice.0.extra', true],
    ['timeline.dice.0.frames.0.extra', true],
    ['timeline.cup.frames.0.extra', true],
    ['authoritativeValuesBySlot.0.extra', true],
    ['input.rolledSlots', [2, 2]],
    ['timeline.rollId', 'other'],
    ['timeline.seed', 'other'],
    ['timeline.cup.style', 'burst'],
    ['timeline.dice.0.slot', 1],
    ['authoritativeValuesBySlot.0.slot', 1],
    ['timeline.dice.0.value', 7],
    ['authoritativeValuesBySlot.0.value', 1.5],
    ['timeline.durationMs', NaN],
    ['timeline.rollArea.width', Infinity],
    ['timeline.rollArea.topZ', NaN],
    ['timeline.cup.innerHeight', undefined],
    ['timeline.cup.stageX', Infinity],
    ['timeline.dice.0.frames.0.t', NaN],
    ['timeline.dice.0.frames.0.p', [0, 0]],
    ['timeline.dice.0.frames.0.q', [0, 0, 0, Infinity]],
    ['timeline.cup.frames.0.mode', 'unknown'],
    ['timeline.cup.frames.0.visible', 1],
    ['timeline.cup.frames.0.q', [0, 0, 1]],
    ['timeline.dice', []],
    ['authoritativeValuesBySlot', []],
    ['replayDigest', null],
  ] as const)('rejects malformed %s', (path, value) => {
    expect(isSimulationResult(changed(path, value))).toBe(false);
  });

  test('preserves existing cup metadata tolerance and finite optional geometry', () => {
    expect(isSimulationResult(changed('timeline.cup.direction', 'rightToLeft'))).toBe(true);
    expect(isSimulationResult(changed('timeline.cup.stageX', 2))).toBe(true);
    expect(isSimulationResult(changed('timeline.rollArea.topZ', 0))).toBe(true);
  });

  test.each([
    ['timeline.dice', 1],
    ['timeline.dice.0.frames', 1],
    ['timeline.cup.frames', 1],
    ['authoritativeValuesBySlot', 1],
    ['timeline.dice.0.frames.0.p', 3],
    ['timeline.dice.0.frames.0.q', 4],
    ['timeline.cup.frames.0.p', 3],
    ['timeline.cup.frames.0.q', 4],
  ] as const)('rejects holes and explicit undefined in %s', (path, length) => {
    expect(isSimulationResult(changed(path, Array(length)))).toBe(false);
    expect(isSimulationResult(changed(path, Array(length).fill(undefined)))).toBe(false);
  });

  test('does not confuse shape validation with digest or outcome agreement', () => {
    expect(isSimulationResult(changed('replayDigest', 'incorrect-digest'))).toBe(true);
    expect(isSimulationResult(changed('authoritativeValuesBySlot.0.value', 1))).toBe(true);
  });
});

describe('compact simulation outcome shape', () => {
  const outcome = {
    input: result.input,
    authoritativeValuesBySlot: result.authoritativeValuesBySlot,
  };
  test('accepts the exact compact result without allocating or mutating its data', () => {
    const copy = structuredClone(outcome);
    expect(isSimulationOutcome(outcome)).toBe(true);
    expect(outcome).toEqual(copy);
    expect(isSimulationOutcome(result)).toBe(false);
  });
  test.each([
    { ...outcome, extra: true },
    { ...outcome, input: { ...outcome.input, extra: true } },
    { ...outcome, input: { ...outcome.input, rolledSlots: [] } },
    { ...outcome, input: { ...outcome.input, rolledSlots: [2, 1] } },
    { ...outcome, input: { ...outcome.input, rolledSlots: [2, 2] } },
    { ...outcome, input: { ...outcome.input, rolledSlots: [5] } },
    { ...outcome, input: { ...outcome.input, rolledSlots: Array(1) } },
    ...[0, 7, 1.5, NaN, Infinity, '2'].map((value) => ({
      ...outcome,
      authoritativeValuesBySlot: [{ slot: 2, value }],
    })),
    { ...outcome, authoritativeValuesBySlot: Array(1) },
    { ...outcome, authoritativeValuesBySlot: [undefined] },
    { ...outcome, authoritativeValuesBySlot: [] },
    { ...outcome, authoritativeValuesBySlot: [{ slot: 1, value: 2 }] },
    { ...outcome, authoritativeValuesBySlot: [{ slot: 2, value: 2, extra: true }] },
  ])('rejects malformed compact outcomes: %p', (value) => {
    expect(isSimulationOutcome(value)).toBe(false);
  });
  test('checks ascending slots and dense faces for every supported die count', () => {
    for (let count = 1; count <= 5; count += 1) {
      const slots = Array.from({ length: count }, (_, index) => index);
      const input = { ...outcome.input, rolledSlots: slots };
      const faces = slots.map((slot) => ({ slot, value: 6 }));
      expect(isSimulationOutcome({ input, authoritativeValuesBySlot: faces })).toBe(true);
      if (count > 1)
        expect(
          isSimulationOutcome({ input, authoritativeValuesBySlot: [...faces].reverse() }),
        ).toBe(false);
    }
  });
});
