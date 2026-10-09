import { expect, test } from 'bun:test';

import { createInitialDiceLayout } from './initial-dice-layout';

test.each([1, 2, 3, 4])('places %i dice in one centered layer', (count) => {
  const placements = createInitialDiceLayout('small-layout', count);
  expect(placements).toHaveLength(count);
  expect(placements.every(({ layer }) => layer === 0)).toBe(true);
  expect(placements.reduce((sum, { x }) => sum + x, 0)).toBeCloseTo(0, 12);
  expect(placements.reduce((sum, { z }) => sum + z, 0)).toBeCloseTo(0, 12);
});

test('places five dice in two layers without sharing call results', () => {
  const before = createInitialDiceLayout('layout-coverage-3', 5);
  expect(before.filter(({ layer }) => layer === 0)).toHaveLength(2);
  expect(before.filter(({ layer }) => layer === 1)).toHaveLength(3);
  createInitialDiceLayout('different-layout', 1);
  const after = createInitialDiceLayout('layout-coverage-3', 5);
  expect(after).toEqual(before);
  expect(after).not.toBe(before);
  expect(after[0]).not.toBe(before[0]);
});

// Frozen seed mappings preserve preset choice, placement direction and die identity.
test.each([
  {
    seed: 'layout-coverage-0',
    first: { x: 0.18105, z: -0.30721, layer: 1 },
    layers: [1, 0, 1, 1, 0],
  },
  {
    seed: 'layout-coverage-1',
    first: { x: 0.15779, z: 0.205767, layer: 1 },
    layers: [1, 0, 1, 1, 0],
  },
  {
    seed: 'layout-coverage-3',
    first: { x: -0.458006, z: 0.381111, layer: 0 },
    layers: [0, 1, 0, 1, 1],
  },
  {
    seed: 'layout-coverage-8',
    first: { x: -0.524209, z: -0.247036, layer: 1 },
    layers: [1, 0, 1, 0, 1],
  },
])('reproduces the reviewed five-die placement for $seed', ({ seed, first, layers }) => {
  const layout = createInitialDiceLayout(seed, 5);
  expect(layout[0]).toEqual(first);
  expect(layout.map(({ layer }) => layer)).toEqual([...layers]);
});

test('changes die identities within the same preset while preserving its geometry', () => {
  const first = createInitialDiceLayout('layout-coverage-3', 5);
  const second = createInitialDiceLayout('layout-coverage-4', 5);
  expect(second).not.toEqual(first);
  expect(second.map((placement) => JSON.stringify(placement)).sort()).toEqual(
    first.map((placement) => JSON.stringify(placement)).sort(),
  );
});

test.each([1, 2, 3, 4])(
  'preserves the fixed %i-die layout across seeds and five-die calls',
  (count) => {
    const first = createInitialDiceLayout('small-layout', count);
    createInitialDiceLayout('layout-coverage-8', 5);
    expect(createInitialDiceLayout('other-small-layout', count)).toEqual(first);
  },
);
