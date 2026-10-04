import { describe, expect, it } from 'bun:test';

import {
  CHARACTER_CATALOG,
  CHARACTER_IDS,
  isCharacterId,
  resolveCharacterImageAssetId,
} from './characters';

describe('character catalog', () => {
  it('defines twelve characters in the same order for both styles', () => {
    expect(CHARACTER_IDS).toEqual([
      'navy-bob',
      'blonde-buns',
      'sage-bucket',
      'rose-tails',
      'black-hime',
      'brown-braid',
      'silver-sweep',
      'onyx-topknot',
      'honey-cap',
      'onyx-ribbon',
      'peach-curtain',
      'chestnut-curtain',
    ]);
    expect(CHARACTER_CATALOG).toHaveLength(12);
    expect(new Set(CHARACTER_CATALOG.map(({ id }) => id)).size).toBe(12);
    expect(CHARACTER_CATALOG.every((character) => !('name' in character))).toBe(true);
  });

  it('assigns one unique original and variant asset to every character', () => {
    const imageAssetIds = CHARACTER_CATALOG.flatMap(({ imageAssetIds }) => [
      imageAssetIds.original,
      imageAssetIds.variant,
    ]);

    expect(imageAssetIds).toHaveLength(24);
    expect(new Set(imageAssetIds).size).toBe(24);
    expect(imageAssetIds.every((id) => /^character\.[a-z-]+\.(original|variant)$/u.test(id))).toBe(
      true,
    );
  });

  it('resolves image assets by ID, never by catalog position', () => {
    expect(resolveCharacterImageAssetId('rose-tails', false)).toBe('character.rose-tails.original');
    expect(resolveCharacterImageAssetId('rose-tails', true)).toBe('character.rose-tails.variant');
  });

  it.each(['navy-bob', 'onyx-topknot'])('accepts character ID %s', (value) => {
    expect(isCharacterId(value)).toBe(true);
  });

  it.each([1, 8, '1', 'unknown', null])('rejects character ID %p', (value) => {
    expect(isCharacterId(value)).toBe(false);
  });
});
