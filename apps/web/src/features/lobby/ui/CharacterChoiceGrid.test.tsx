// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { CHARACTER_IDS } from '@repo/game-assets/characters';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { CharacterChoiceGrid } from '@/features/lobby/ui/CharacterChoiceGrid';

afterEach(cleanup);

const choices = CHARACTER_IDS.map((characterId, index) => ({
  characterId,
  imageUrl: `/characters/${index + 1}.webp`,
  alt: `Character ${index + 1}`,
}));

test('exposes only the supplied character as the current selection', () => {
  render(
    <CharacterChoiceGrid
      label='Character choices'
      variant={false}
      styleLabels={['Style 1', 'Style 2']}
      onStyleChange={() => undefined}
      choices={choices}
      selectedCharacterId='silver-sweep'
      onSelect={() => undefined}
    />,
  );

  expect(screen.getAllByRole('button', { pressed: true })).toEqual([
    screen.getByRole('button', { name: 'Character 7' }),
  ]);
});

test('emits the selected character identity immediately', () => {
  let selected = '';
  render(
    <CharacterChoiceGrid
      label='Character choices'
      variant={false}
      styleLabels={['Style 1', 'Style 2']}
      onStyleChange={() => undefined}
      choices={choices}
      selectedCharacterId='navy-bob'
      onSelect={(characterId) => {
        selected = characterId;
      }}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: 'Character 7' }));

  expect(selected).toBe('silver-sweep');
});
