// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { CATEGORY_IDS, type CategoryId } from '@repo/yacht-rules';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';

import { ScoreCategoryCell } from '@/features/game/ui/score/ScoreCategoryCell';
import type { CategoryLabels } from '@/features/game/ui/score/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const categories = Object.fromEntries(
  CATEGORY_IDS.map((categoryId) => [categoryId, categoryId]),
) as CategoryLabels;

test('allows a selectable preview zero to emit its category intent', () => {
  const selected: CategoryId[] = [];
  render(
    <ScoreCategoryCell
      categoryId='choice'
      display={{ state: 'preview', value: 0 }}
      input='selectable'
      label={categories.choice}
      emptyValueLabel='Unrecorded'
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
      categoryId='choice'
      display={{ state: 'preview', value: 0 }}
      input='selectable'
      label={categories.choice}
      emptyValueLabel='Unrecorded'
      interactionLocked
      onSelect={(categoryId) => selected.push(categoryId)}
    />,
  );
  const cell = screen.getByRole('button', { name: 'choice · 0' });
  fireEvent.click(cell);

  expect(selected).toEqual([]);
  expect(cell.getAttribute('data-input-available')).toBe('false');
  expect(cell.getAttribute('data-value-state')).toBe('preview');
});

test('does not emit an intent for recorded or opponent values', () => {
  let intents = 0;
  render(
    <>
      <ScoreCategoryCell
        categoryId='ones'
        display={{ state: 'recorded', value: 0 }}
        input='recorded'
        label={categories.ones}
        emptyValueLabel='Unrecorded'
        onSelect={() => intents++}
      />
      <ScoreCategoryCell
        categoryId='twos'
        display={{ state: 'recorded', value: 4 }}
        input='disabled'
        label={categories.twos}
        emptyValueLabel='Unrecorded'
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
  expect(opponentCell.getAttribute('data-value-state')).toBe('recorded');
  expect(opponentCell.hasAttribute('disabled')).toBe(true);
});

test('reports a recorded viewer category as blocked without selecting it', () => {
  const selected: CategoryId[] = [];
  const blocked: CategoryId[] = [];
  render(
    <ScoreCategoryCell
      categoryId='ones'
      display={{ state: 'recorded', value: 0 }}
      input='recorded'
      label={categories.ones}
      emptyValueLabel='Unrecorded'
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
  const view = renderToStaticMarkup(
    <ScoreCategoryCell
      categoryId='ones'
      display={{ state: 'empty', value: null }}
      input='disabled'
      label={categories.ones}
      emptyValueLabel='Unrecorded'
    />,
  );
  expect(view).toContain('aria-label="ones · Unrecorded"');
  expect(view).toMatch(/data-score-value-kind="empty"[^>]*><\/span>/u);
  expect(view).not.toContain('—');
  const utils = renderToStaticMarkup(
    <ScoreCategoryCell
      categoryId='ones'
      display={{ state: 'recorded', value: 0 }}
      input='disabled'
      label={categories.ones}
      emptyValueLabel='Unrecorded'
    />,
  );
  expect(utils).toContain('aria-label="ones · 0"');
  expect(utils).toMatch(/data-score-value-kind="recorded"[^>]*>0<\/span>/u);
});

test('only offers the input cue for an unlocked selectable preview, including zero', () => {
  for (const locked of [false, true]) {
    const view = renderToStaticMarkup(
      <ScoreCategoryCell
        categoryId='choice'
        display={{ state: 'preview', value: 0 }}
        input='selectable'
        label={categories.choice}
        interactionLocked={locked}
        emptyValueLabel='Unrecorded'
      />,
    );
    expect(view).toContain(`data-input-available="${!locked}"`);
    expect(view).toMatch(/data-score-value-kind="preview"[^>]*>0<\/span>/u);
  }
});

/* eslint-disable testing-library/no-node-access -- Verify stable cell elements and aria-hidden Yacht effects without granting scoring input. */
test('Yacht availability and record feedback do not grant scoring input', () => {
  vi.spyOn(performance, 'now').mockReturnValue(200);
  const props = {
    categoryId: 'yacht' as const,
    label: 'Yacht',
    display: { state: 'preview' as const, value: 50 },
    input: 'disabled' as const,
    emptyValueLabel: 'Unrecorded',
  };
  const { rerender } = render(<ScoreCategoryCell {...props} yachtAvailable />);
  const cell = screen.getByRole('button', { name: 'Yacht · 50' });
  expect(cell.querySelector('[data-yacht-ring="available"]')).not.toBeNull();
  expect(cell.hasAttribute('disabled')).toBe(true);
  rerender(
    <ScoreCategoryCell
      {...props}
      recordFeedback={{
        identity: 'record-yacht',
        categoryId: 'yacht',
        score: 50,
        phase: 'confirming',
        timing: { startedAt: 0 },
        bonusEarned: false,
      }}
    />,
  );
  expect(screen.getByRole('button', { name: 'Yacht · 50' })).toBe(cell);
  expect(cell.querySelector('[data-yacht-ring="available"]')).toBeNull();
  expect(cell.querySelector('[data-yacht-ring="recorded"]')).not.toBeNull();
  expect(cell.hasAttribute('disabled')).toBe(true);
});
/* eslint-enable testing-library/no-node-access */
