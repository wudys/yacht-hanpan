import * as crypto from 'node:crypto';

import { AUTOMATIC_POUR_STYLES, POUR_STYLES } from '@repo/dice-simulation/contract';
import { describe, expect, spyOn, test } from 'bun:test';

import { createProductionRollRecipeSource } from '@/roll/production-roll-recipe-source';

describe('production roll recipe source', () => {
  test('uses only selected A/B/D for automatic rolls', () => {
    expect(AUTOMATIC_POUR_STYLES).toEqual(['classic', 'burst', 'oblique']);
    expect(POUR_STYLES).toEqual(['classic', 'burst', 'oblique']);
  });

  test.each([
    [0, 'classic'],
    [1, 'burst'],
    [2, 'oblique'],
  ] as const)('selects automatic style index %i as %s', (index, expected) => {
    const randomInt = spyOn(crypto, 'randomInt').mockImplementation(() => index);
    try {
      expect(createProductionRollRecipeSource().createPourStyle()).toBe(expected);
      expect(randomInt).toHaveBeenCalledTimes(1);
      expect(randomInt).toHaveBeenCalledWith(3);
    } finally {
      randomInt.mockRestore();
    }
  });

  test('creates independent seeds while the request clock is unchanged', () => {
    const now = spyOn(Date, 'now').mockReturnValue(1790726400000);
    try {
      const source = createProductionRollRecipeSource();
      const seeds = Array.from({ length: 1000 }, () => source.createRollSeed());
      expect(new Set(seeds).size).toBe(seeds.length);
    } finally {
      now.mockRestore();
    }
  });

  test('creates semantic server-owned roll identity, seed, and style', () => {
    const source = createProductionRollRecipeSource();
    const first = {
      rollId: source.createRollId(),
      seed: source.createRollSeed(),
      style: source.createPourStyle(),
    };
    const second = {
      rollId: source.createRollId(),
      seed: source.createRollSeed(),
      style: source.createPourStyle(),
    };
    expect(first.rollId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.seed).toMatch(/^[0-9a-f]{32}$/u);
    expect(second.rollId).not.toBe(first.rollId);
    expect(second.seed).not.toBe(first.seed);
    expect(POUR_STYLES).toContain(first.style);
  });
});
