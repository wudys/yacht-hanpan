import { describe, expect, test } from 'bun:test';

import { canonicalizeReplay, ReplayCanonicalizationError } from './canonicalize';
import { POUR_STYLE } from './constants';
import { createReplayDigest } from './replay-digest';
import type { RollTimeline, SimulationInput } from './types';

const input: SimulationInput = {
  rollId: 'roll-digest',
  seed: 'seed-digest',
  rolledSlots: [0],
  pourStyle: POUR_STYLE.CLASSIC,
};

const timeline: RollTimeline = {
  rollId: input.rollId,
  seed: input.seed,
  durationMs: 1200,
  cup: {
    style: POUR_STYLE.CLASSIC,
    shakeAmplitude: 0.1,
    shakeFrequency: 2,
    pourAtMs: 300,
    releaseAtMs: 400,
    exitAtMs: 700,
    stageX: 0.4,
    innerWidth: 1,
    innerDepth: 1.1,
    innerHeight: 1.2,
    frames: [
      { t: 0, p: [0, 1, 0], q: [0, 0, 0, 1], visible: true, mode: 'shake' },
      { t: 700, p: [1, 2, 3], q: [0, 0.1, 0, 0.995], visible: false, mode: 'exit' },
    ],
  },
  rollArea: {
    width: 5,
    depth: 3,
    aspectRatio: 1.6667,
    centerZ: 1.5,
    topZ: 0,
    bottomZ: 3,
  },
  dice: [
    {
      slot: 0,
      value: 4,
      frames: [
        { t: 0, p: [0, 1, 0], q: [0, 0, 0, 1] },
        { t: 1200, p: [1, 0, 1], q: [0.5, 0.5, 0.5, 0.5] },
      ],
    },
  ],
};

describe('canonical replay digest', () => {
  test('creates a version-prefixed lowercase SHA-256 digest', async () => {
    expect(await createReplayDigest(input, timeline)).toMatch(/^sha256-q4-v2:[a-f0-9]{64}$/);
  });

  test('is independent of object insertion order', () => {
    const reordered = {
      dice: timeline.dice,
      rollArea: timeline.rollArea,
      cup: timeline.cup,
      durationMs: timeline.durationMs,
      seed: timeline.seed,
      rollId: timeline.rollId,
    } satisfies RollTimeline;

    expect(canonicalizeReplay(input, reordered)).toBe(canonicalizeReplay(input, timeline));
  });

  test.each([
    [
      'recipe',
      {
        input: { ...input, seed: 'other-seed' },
        timeline: { ...timeline, seed: 'other-seed' },
      },
    ],
    ['duration', { timeline: { ...timeline, durationMs: 1201 } }],
    ['cup timing', { timeline: { ...timeline, cup: { ...timeline.cup, releaseAtMs: 401 } } }],
    [
      'cup frame',
      {
        timeline: {
          ...timeline,
          cup: {
            ...timeline.cup,
            frames: timeline.cup.frames.map((frame, index) =>
              index === 0 ? { ...frame, p: [0.1, 1, 0] as [number, number, number] } : frame,
            ),
          },
        },
      },
    ],
    ['area', { timeline: { ...timeline, rollArea: { ...timeline.rollArea, width: 5.1 } } }],
    [
      'intermediate die frame',
      {
        timeline: {
          ...timeline,
          dice: [
            {
              ...timeline.dice[0],
              frames: [
                { ...timeline.dice[0].frames[0], p: [0.1, 1, 0] as [number, number, number] },
                timeline.dice[0].frames[1],
              ],
            },
          ],
        },
      },
    ],
    [
      'final die frame',
      {
        timeline: {
          ...timeline,
          dice: [
            {
              ...timeline.dice[0],
              frames: [
                timeline.dice[0].frames[0],
                { ...timeline.dice[0].frames[1], p: [1.1, 0, 1] as [number, number, number] },
              ],
            },
          ],
        },
      },
    ],
    ['value', { timeline: { ...timeline, dice: [{ ...timeline.dice[0], value: 5 }] } }],
    [
      'slot identity',
      {
        input: { ...input, rolledSlots: [1] },
        timeline: { ...timeline, dice: [{ ...timeline.dice[0], slot: 1 }] },
      },
    ],
  ] as const)('changes when %s changes', async (_name, change) => {
    const changedInput = 'input' in change ? change.input : input;
    const changedTimeline = 'timeline' in change ? change.timeline : timeline;
    expect(await createReplayDigest(changedInput, changedTimeline)).not.toBe(
      await createReplayDigest(input, timeline),
    );
  });

  test('quantizes numbers to four decimal places', () => {
    const withinQuantum = { ...timeline, durationMs: 1200.00001 };
    expect(canonicalizeReplay(input, withinQuantum)).toBe(canonicalizeReplay(input, timeline));
  });

  test('rejects non-finite numbers instead of serializing them ambiguously', () => {
    expect(() => canonicalizeReplay(input, { ...timeline, durationMs: Number.NaN })).toThrow(
      ReplayCanonicalizationError,
    );
  });

  test.each([
    ['die', 'p'],
    ['die', 'q'],
    ['cup', 'p'],
    ['cup', 'q'],
  ] as const)('rejects missing coordinates in a %s %s tuple', async (owner, coordinate) => {
    const changed = structuredClone(timeline);
    const frame = owner === 'die' ? changed.dice[0]!.frames[0]! : changed.cup.frames[0]!;
    Reflect.deleteProperty(frame[coordinate], 1);
    expect(() => canonicalizeReplay(input, changed)).toThrow(ReplayCanonicalizationError);
    await expect(createReplayDigest(input, changed)).rejects.toBeInstanceOf(
      ReplayCanonicalizationError,
    );
  });
});
