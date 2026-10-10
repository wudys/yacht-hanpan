import * as crypto from 'node:crypto';

import { POUR_STYLES } from '@repo/dice-simulation/contract';
import { describe, expect, spyOn, test } from 'bun:test';

import { createProductionRollRecipeSource } from '@/roll/production-roll-recipe-source';

describe('production roll recipe source', () => {
  test('selects only the supported burst and oblique styles', () => {
    expect(POUR_STYLES).toEqual(['burst', 'oblique']);
  });

  test.each([0, 1])('uses burst for one die regardless of random index %i', (index) => {
    const randomInt = spyOn(crypto, 'randomInt').mockImplementation(() => index);
    try {
      expect(createProductionRollRecipeSource().createPourStyle(1)).toBe('burst');
      expect(randomInt).not.toHaveBeenCalled();
    } finally {
      randomInt.mockRestore();
    }
  });

  describe.each([2, 3, 4, 5])('%i dice', (diceCount) => {
    test.each([
      [0, 'burst'],
      [1, 'oblique'],
    ] as const)('selects automatic style index %i as %s', (index, expected) => {
      const randomInt = spyOn(crypto, 'randomInt').mockImplementation(() => index);
      try {
        expect(createProductionRollRecipeSource().createPourStyle(diceCount)).toBe(expected);
        expect(randomInt).toHaveBeenCalledTimes(1);
        expect(randomInt).toHaveBeenCalledWith(2);
      } finally {
        randomInt.mockRestore();
      }
    });
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
      style: source.createPourStyle(5),
    };
    const second = {
      rollId: source.createRollId(),
      seed: source.createRollSeed(),
      style: source.createPourStyle(5),
    };
    expect(first.rollId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(first.seed).toMatch(/^[0-9a-f]{32}$/u);
    expect(second.rollId).not.toBe(first.rollId);
    expect(second.seed).not.toBe(first.seed);
    expect(POUR_STYLES).toContain(first.style);
  });
});
