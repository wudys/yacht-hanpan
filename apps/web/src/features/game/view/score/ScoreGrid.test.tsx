// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { CATEGORY_IDS, type CategoryId } from '@repo/yacht-rules';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test } from 'vitest';

import type { ScoreRowViewModel } from '@/features/game/view/game-view-model';
import { ScoreCategoryCell } from '@/features/game/view/score/ScoreCategoryCell';
import { ScoreGrid } from '@/features/game/view/score/ScoreGrid';
import type { CategoryLabels } from '@/features/game/view/score/types';

afterEach(cleanup);

const categories = Object.fromEntries(
  CATEGORY_IDS.map((categoryId) => [categoryId, categoryId]),
) as CategoryLabels;

const rows: readonly ScoreRowViewModel[] = CATEGORY_IDS.map((categoryId, index) => ({
  categoryId,
  viewerScore: index === 0 ? 0 : null,
  opponentScore: index === 1 ? 4 : null,
  previewScore: index === 6 ? 0 : index,
  selectable: index >= 6,
}));

test('renders only the active group as a two by three score grid', () => {
  const view = renderToStaticMarkup(
    <ScoreGrid
      rows={rows}
      categories={categories}
      activeGroup='lower'
      mode='viewer-turn'
      labels={{
        upper: 'Upper',
        lower: 'Lower',
        highestUpper: '5',
        highestLower: '22',
        emptyValue: 'Unrecorded',
      }}
    />,
  );

  expect(view.match(/data-score-cell=/g)?.length).toBe(6);
  expect(view).toContain('data-score-category="choice"');
  expect(view).not.toContain('data-score-category="ones"');
});

test('allows a selectable preview zero to emit its category intent', () => {
  const selected: CategoryId[] = [];
  render(
    <ScoreCategoryCell
      row={rows[6]!}
      label={categories.choice}
      emptyValueLabel='Unrecorded'
      mode='viewer-turn'
      onSelect={(categoryId) => selected.push(categoryId)}
    />,
  );
  const cell = screen.getByRole('button', { name: 'choice · 0' });
  fireEvent.click(cell);

  expect(selected).toEqual(['choice']);
  expect(cell.getAttribute('data-value-state')).toBe('preview');
});

test('keeps preview presentation while interaction is locked', () => {
  const selected: CategoryId[] = [];
  render(
    <ScoreCategoryCell
      row={rows[6]!}
      label={categories.choice}
      emptyValueLabel='Unrecorded'
      mode='viewer-turn'
      interactionLocked
      onSelect={(categoryId) => selected.push(categoryId)}
    />,
  );
  const cell = screen.getByRole('button', { name: 'choice · 0' });
  fireEvent.click(cell);

  expect(selected).toEqual([]);
  expect(cell.getAttribute('data-mode')).toBe('viewer-turn');
  expect(cell.getAttribute('data-value-state')).toBe('preview');
});

test('does not emit an intent for recorded or opponent values', () => {
  let intents = 0;
  render(
    <>
      <ScoreCategoryCell
        row={rows[0]!}
        label={categories.ones}
        emptyValueLabel='Unrecorded'
        mode='viewer-turn'
        onSelect={() => intents++}
      />
      <ScoreCategoryCell
        row={rows[1]!}
        label={categories.twos}
        emptyValueLabel='Unrecorded'
        mode='opponent-turn'
        onSelect={() => intents++}
      />
    </>,
  );
  const recordedCell = screen.getByRole('button', { name: 'ones · 0' });
  const opponentCell = screen.getByRole('button', { name: 'twos · 4' });
  fireEvent.click(recordedCell);
  fireEvent.click(opponentCell);

  expect(intents).toBe(0);
  expect(recordedCell.getAttribute('data-value-state')).toBe('recorded');
  expect(opponentCell.getAttribute('data-mode')).toBe('opponent-turn');
});

test('reports a recorded viewer category as blocked without selecting it', () => {
  const selected: CategoryId[] = [];
  const blocked: CategoryId[] = [];
  render(
    <ScoreCategoryCell
      row={rows[0]!}
      label={categories.ones}
      emptyValueLabel='Unrecorded'
      mode='viewer-turn'
      onSelect={(categoryId) => selected.push(categoryId)}
      onBlockedSelect={(categoryId) => blocked.push(categoryId)}
    />,
  );
  const cell = screen.getByRole('button', { name: 'ones · 0' });
  fireEvent.click(cell);

  expect(selected).toEqual([]);
  expect(blocked).toEqual(['ones']);
  expect(cell.hasAttribute('disabled')).toBe(false);
  expect(cell.getAttribute('aria-disabled')).toBe('true');
});

test('renders empty slots without a dash while preserving their accessible meaning and recorded zero', () => {
  for (const mode of ['disabled', 'opponent-turn'] as const) {
    const view = renderToStaticMarkup(
      <ScoreCategoryCell
        row={{ ...rows[0]!, viewerScore: null, opponentScore: null }}
        label={categories.ones}
        mode={mode}
        emptyValueLabel='Unrecorded'
      />,
    );
    expect(view).toContain('aria-label="ones · Unrecorded"');
    expect(view).toContain('data-score-value-kind="empty"></span>');
    expect(view).not.toContain('—');
  }
  const view = renderToStaticMarkup(
    <ScoreCategoryCell
      row={rows[0]!}
      label={categories.ones}
      mode='disabled'
      emptyValueLabel='Unrecorded'
    />,
  );
  expect(view).toContain('aria-label="ones · 0"');
  expect(view).toContain('data-score-value-kind="recorded">0</span>');
});

test('hides an absent group best without hiding a valid zero', () => {
  const view = renderToStaticMarkup(
    <ScoreGrid
      rows={rows}
      categories={categories}
      activeGroup='lower'
      mode='viewer-turn'
      labels={{
        upper: 'Upper',
        lower: 'Lower',
        highestUpper: null,
        highestLower: 'Max 0',
        emptyValue: 'Unrecorded',
      }}
    />,
  );
  expect(view).toContain('<strong>Upper</strong></button>');
  expect(view).toContain('<span>Max 0</span>');
});

test('only offers the input cue for an unlocked selectable preview, including zero', () => {
  for (const locked of [false, true]) {
    const view = renderToStaticMarkup(
      <ScoreCategoryCell
        row={rows[6]!}
        label={categories.choice}
        mode='viewer-turn'
        interactionLocked={locked}
        emptyValueLabel='Unrecorded'
      />,
    );
    expect(view).toContain(`data-input-available="${!locked}"`);
    expect(view).toContain('data-score-value-kind="preview">0</span>');
  }
});
