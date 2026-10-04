import { AUTOMATIC_POUR_STYLES, POUR_STYLES } from '@repo/dice-simulation/contract';
import { describe, expect, spyOn, test } from 'bun:test';

import { createProductionRollRecipeSource } from '@/roll/production-roll-recipe-source';

describe('production roll recipe source', () => {
  test('uses only selected A/B/D for automatic rolls', () => {
    expect(AUTOMATIC_POUR_STYLES).toEqual(['classic', 'burst', 'oblique']);
    const source = createProductionRollRecipeSource();
    for (let index = 0; index < 64; index += 1) {
      const selected = source.createPourStyle();
      expect(AUTOMATIC_POUR_STYLES.some((style) => style === selected)).toBe(true);
    }
    expect(POUR_STYLES).toEqual(['classic', 'burst', 'oblique']);
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
