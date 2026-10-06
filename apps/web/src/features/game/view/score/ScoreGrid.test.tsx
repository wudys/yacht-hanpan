// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { CATEGORY_IDS, type CategoryId } from '@repo/yacht-rules';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test, vi } from 'vitest';

import type { ScoreRowViewModel } from '@/features/game/view/game-view-model';
import { ScoreCategoryCell } from '@/features/game/view/score/ScoreCategoryCell';
import { ScoreGrid } from '@/features/game/view/score/ScoreGrid';
import type { CategoryLabels } from '@/features/game/view/score/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
      displayOwner='viewer'
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

test('hides an absent group best without hiding a valid zero', () => {
  const view = renderToStaticMarkup(
    <ScoreGrid
      rows={rows}
      displayOwner='viewer'
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

test('changes displayed scores in the same cells while preserving latest input eligibility', () => {
  const selected: CategoryId[] = [];
  const blocked: CategoryId[] = [];
  const coherentRows = rows.map((row) =>
    row.categoryId === 'choice'
      ? { ...row, viewerScore: null, opponentScore: 20, previewScore: 24, selectable: true }
      : row.categoryId === 'yacht'
        ? { ...row, viewerScore: 0, opponentScore: 50, previewScore: null, selectable: false }
        : row,
  );
  const props = {
    rows: coherentRows,
    categories,
    activeGroup: 'lower' as const,
    mode: 'viewer-turn' as const,
    labels: {
      upper: 'Upper',
      lower: 'Lower',
      highestUpper: null,
      highestLower: null,
      emptyValue: 'Unrecorded',
    },
    onSelect: (categoryId: CategoryId) => selected.push(categoryId),
    onBlockedSelect: (categoryId: CategoryId) => blocked.push(categoryId),
  };
  const { rerender } = render(<ScoreGrid {...props} displayOwner='viewer' />);
  const cell = screen.getByRole('button', { name: 'choice · 24' });
  rerender(<ScoreGrid {...props} displayOwner='opponent' />);
  expect(screen.getByRole('button', { name: 'choice · 20' })).toBe(cell);
  fireEvent.click(cell);
  fireEvent.click(screen.getByRole('button', { name: 'yacht · 50' }));
  expect(selected).toEqual(['choice']);
  expect(blocked).toEqual(['yacht']);
  rerender(<ScoreGrid {...props} displayOwner='viewer' />);
  expect(screen.getByRole('button', { name: 'choice · 24' })).toBe(cell);
  fireEvent.click(screen.getByRole('button', { name: 'yacht · 0' }));
  expect(blocked).toEqual(['yacht', 'yacht']);
  rerender(<ScoreGrid {...props} displayOwner='viewer' mode='opponent-turn' />);
  fireEvent.click(screen.getByRole('button', { name: 'choice · 24' }));
  fireEvent.click(screen.getByRole('button', { name: 'yacht · 0' }));
  expect(selected).toEqual(['choice']);
  expect(blocked).toEqual(['yacht', 'yacht']);
});

/* eslint-disable testing-library/no-node-access -- Verify persistent cell parts and aria-hidden effect epochs across transitions. */
test('keeps the score cell, icon and label stable through the record handoff', () => {
  vi.spyOn(performance, 'now').mockReturnValue(850);
  const props = {
    rows: rows.map((row) => ({ ...row, previewScore: null, selectable: false })),
    displayOwner: 'viewer' as const,
    categories,
    activeGroup: 'upper' as const,
    mode: 'opponent-turn' as const,
    labels: {
      upper: 'Upper',
      lower: 'Lower',
      highestUpper: null,
      highestLower: null,
      emptyValue: 'Unrecorded',
    },
  };
  const feedback = {
    identity: 'record-1',
    categoryId: 'ones' as const,
    score: 0,
    timing: { mode: 'running' as const, startedAt: 0 },
    bonusEarned: false,
  };
  const { rerender } = render(
    <ScoreGrid {...props} recordFeedback={{ ...feedback, phase: 'outgoing' }} />,
  );
  const cell = screen.getByRole('button', { name: 'ones · 0' });
  const icon = cell.querySelector('img');
  const label = cell.querySelector('.score-category-cell__label');
  expect(cell.getAttribute('data-score-confirmed')).toBe('true');
  expect(cell.getAttribute('data-input-available')).toBe('false');
  rerender(
    <ScoreGrid
      {...props}
      displayOwner='opponent'
      recordFeedback={{ ...feedback, phase: 'incoming' }}
    />,
  );
  expect(screen.getByRole('button', { name: 'ones · Unrecorded' })).toBe(cell);
  expect(cell.querySelector('img')).toBe(icon);
  expect(cell.querySelector('.score-category-cell__label')).toBe(label);
  expect(cell.hasAttribute('data-score-confirmed')).toBe(false);
  expect(cell.getAttribute('data-input-available')).toBe('false');
});

test('does not restart expired record effects after a manual tab round trip', () => {
  const now = vi.spyOn(performance, 'now').mockReturnValue(100);
  const props = {
    rows: rows.map((row) => ({ ...row, previewScore: null, selectable: false })),
    displayOwner: 'viewer' as const,
    categories,
    mode: 'opponent-turn' as const,
    labels: {
      upper: 'Upper',
      lower: 'Lower',
      highestUpper: null,
      highestLower: null,
      emptyValue: 'Unrecorded',
    },
    recordFeedback: {
      identity: 'record-1',
      categoryId: 'choice' as const,
      score: 20,
      phase: 'confirming' as const,
      timing: { mode: 'running' as const, startedAt: 0 },
      bonusEarned: false,
    },
  };
  const { rerender } = render(<ScoreGrid {...props} activeGroup='lower' />);
  const cell = screen.getByRole('button', { name: 'choice · Unrecorded' });
  expect(cell.querySelector('.score-feedback__effect')?.getAttribute('style')).toContain('-100ms');
  rerender(<ScoreGrid {...props} activeGroup='upper' />);
  now.mockReturnValue(700);
  rerender(<ScoreGrid {...props} activeGroup='lower' />);
  const remountedCell = screen.getByRole('button', { name: 'choice · Unrecorded' });
  expect(remountedCell.querySelector('.score-feedback__effect')).toBeNull();
});

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
        timing: { mode: 'running' as const, startedAt: 0 },
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
