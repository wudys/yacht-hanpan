import { expect, test } from 'bun:test';

import { requireGameAsset } from './index';
import { GAME_ASSET_MANIFEST } from './manifest.generated';

test('resolves every catalog asset without changing its URL or metadata', () => {
  for (const entry of GAME_ASSET_MANIFEST) {
    expect(requireGameAsset(entry.id)).toEqual(entry);
  }
});

test('identifies a missing required asset', () => {
  expect(() => {
    // @ts-expect-error Invalid runtime callers still receive the missing-asset error.
    requireGameAsset('missing.required-asset');
  }).toThrow('Required game asset is missing: missing.required-asset');
});
