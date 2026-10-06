// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { CATEGORY_IDS } from '@repo/yacht-rules';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test } from 'vitest';

import { GameBoard, type GameBoardProps } from '@/features/game/view/board/GameBoard';
import type { CategoryLabels } from '@/features/game/view/score';

afterEach(() => cleanup());

const categories = Object.fromEntries(
  CATEGORY_IDS.map((categoryId) => [categoryId, categoryId]),
) as CategoryLabels;
const model: GameBoardProps['model'] = {
  turn: {
    isViewerTurn: true,
    ordinal: 2,
    total: 12,
    rollCount: 1,
    heldSlots: [0],
    showFirstRollGuide: false,
    dice: [
      { slot: 0, value: 1, held: true },
      { slot: 1, value: 2, held: false },
      { slot: 2, value: 3, held: false },
      { slot: 3, value: 4, held: false },
      { slot: 4, value: 5, held: false },
    ],
  },
  scoreRows: CATEGORY_IDS.map((categoryId, index) => ({
    categoryId,
    viewerScore: null,
    opponentScore: null,
    previewScore: index,
    selectable: true,
  })),
  actions: { canRoll: true, canHold: true, canScore: true },
};
const labels = {
  turn: 'Turn 2/12',
  timer: '52 seconds',
  settings: 'Settings',
  diceStage: 'Dice stage',
  heldDice: 'Held dice',
  rollsRemaining: '2 rolls left',
  total: '18',
  bonus: 'Bonus',
  bonusStatus: 'Bonus not earned',
  bonusInfo: 'Bonus info',
  scoreboard: 'Scoreboard',
  upper: 'Upper',
  lower: 'Lower',
  highestUpper: 'Highest 5',
  highestLower: 'Highest 11',
  firstRollGuide: 'First roll guide',
  emptyScore: 'Unrecorded',
} as const;

test('composes the fixed game bands around an injected physics stage', () => {
  const view = renderToStaticMarkup(
    <GameBoard
      scoreDisplay={{
        owner: 'viewer',
        showFirstRollGuide: false,
      }}
      bonusEarned={false}
      rollAction={{ label: 'Roll again', readOnly: false }}
      model={model}
      summaryPlayer={{
        imageUrl: '/viewer.webp',
        imageAlt: 'You',
        label: 'You',
      }}
      categories={categories}
      activeGroup='lower'
      labels={labels}
      diceStage={<div data-physics-stage='true' />}
    />,
  );

  expect(view.match(/data-game-band=/g)?.length).toBe(4);
  expect(view).toContain('data-dice-stage-slot="true"');
  expect(view).toContain('data-physics-stage="true"');
  expect(view.match(/data-held-slot=/g)?.length).toBe(5);
  const rackSlots = view.match(/<button class="held-dice-rack__slot"[^>]*>/g) ?? [];
  expect(rackSlots[0]).not.toContain('disabled');
  expect(rackSlots.slice(1).every((slot) => slot.includes('disabled'))).toBe(true);
  expect(view).toContain('data-die-face="1"');
  expect(view.match(/data-die-pip=/g)?.length).toBe(1);
  expect(view.match(/data-player-summary=/g)?.length).toBe(1);
  expect(view).toContain('data-bonus-info-action="true"');
  expect(view.match(/data-score-cell=/g)?.length).toBe(6);
  expect(view.match(/>18</g)?.length).toBe(1);
});

test('renders the authoritative held order without changing die slot identity', () => {
  const view = renderToStaticMarkup(
    <GameBoard
      scoreDisplay={{
        owner: 'viewer',
        showFirstRollGuide: false,
      }}
      bonusEarned={false}
      rollAction={{ label: 'Roll again', readOnly: false }}
      model={{
        ...model,
        turn: {
          ...model.turn!,
          heldSlots: [3, 0],
          dice: [
            { slot: 0, value: 1, held: true },
            { slot: 1, value: 2, held: false },
            { slot: 2, value: 3, held: false },
            { slot: 3, value: 4, held: true },
            { slot: 4, value: 5, held: false },
          ],
        },
      }}
      summaryPlayer={{ imageAlt: 'You', label: 'You' }}
      categories={categories}
      activeGroup='lower'
      labels={labels}
    />,
  );
  const held = [...view.matchAll(/data-held-slot="(\d)"[^>]*data-held="true"/g)].map((match) =>
    Number(match[1]),
  );
  expect(held).toEqual([3, 0]);
});

test('packs held dice to the left while retaining their authoritative slot identity', () => {
  const view = renderToStaticMarkup(
    <GameBoard
      scoreDisplay={{
        owner: 'viewer',
        showFirstRollGuide: false,
      }}
      bonusEarned={false}
      rollAction={{ label: 'Roll again', readOnly: false }}
      model={{
        ...model,
        turn: {
          ...model.turn!,
          heldSlots: [4],
          dice: [
            { slot: 0, value: 1, held: false },
            { slot: 1, value: 2, held: false },
            { slot: 2, value: 3, held: false },
            { slot: 3, value: 4, held: false },
            { slot: 4, value: 5, held: true },
          ],
        },
      }}
      summaryPlayer={{ imageAlt: 'You', label: 'You' }}
      categories={categories}
      activeGroup='lower'
      labels={labels}
    />,
  );
  const slots = view.match(/<button class="held-dice-rack__slot"[^>]*>/g) ?? [];
  expect(slots[0]).toContain('data-held-slot="4"');
  expect(slots[0]).not.toContain('disabled');
  expect(slots.slice(1).every((slot) => slot.includes('disabled'))).toBe(true);
});

test('keeps the authoritative board presentation while input is locked', () => {
  const view = renderToStaticMarkup(
    <GameBoard
      scoreDisplay={{
        owner: 'viewer',
        showFirstRollGuide: false,
      }}
      bonusEarned={false}
      rollAction={{ label: 'Roll again', readOnly: false }}
      model={model}
      summaryPlayer={{
        imageUrl: '/viewer.webp',
        imageAlt: 'You',
        label: 'You',
      }}
      categories={categories}
      activeGroup='lower'
      labels={labels}
      interactionLocked
      rollRailHidden
      diceStage={<div data-physics-stage='true' />}
    />,
  );

  expect(view).toContain('data-physics-stage="true"');
  expect(view).toContain('data-roll-rail-hidden="true"');
  expect(view).toContain('aria-hidden="true"');
  expect(view).toContain('data-mode="viewer-turn"');
  expect(view).toContain('data-value-state="preview"');
});

test.each([undefined, 'Applying result'])(
  'renders the completed roll as a status with progress=%s',
  (progress) => {
    const view = renderToStaticMarkup(
      <GameBoard
        scoreDisplay={{
          owner: 'viewer',
          showFirstRollGuide: false,
        }}
        bonusEarned={false}
        rollAction={{ label: 'Roll complete', readOnly: true }}
        rollProgress={progress}
        model={{
          ...model,
          turn: { ...model.turn!, rollCount: 3 },
          actions: { ...model.actions, canRoll: false },
        }}
        summaryPlayer={{ imageAlt: 'You', label: 'You' }}
        categories={categories}
        activeGroup='lower'
        labels={labels}
      />,
    );
    const rail = view.match(
      /<div class="roll-action-rail"[^>]*>([\s\S]*?)<span class="status-pill">/u,
    )?.[1];

    expect(rail).toContain('role="status"');
    expect(rail).toContain(progress ?? 'Roll complete');
    expect(rail).not.toContain('<button');
  },
);

test('shows the opponent scorecard immediately on an opponent pre-roll turn', () => {
  const view = renderToStaticMarkup(
    <GameBoard
      scoreDisplay={{
        owner: 'opponent',
        showFirstRollGuide: false,
      }}
      bonusEarned={false}
      rollAction={{ label: 'Their turn', readOnly: true }}
      model={{
        ...model,
        turn: {
          ...model.turn!,
          isViewerTurn: false,
          rollCount: 0,
          heldSlots: [],
          dice: [],
        },
        scoreRows: model.scoreRows.map((row) =>
          row.categoryId === 'choice'
            ? { ...row, viewerScore: 19, opponentScore: 7, previewScore: null, selectable: false }
            : row,
        ),
      }}
      summaryPlayer={{ imageAlt: 'Opponent', label: 'Opponent' }}
      categories={categories}
      activeGroup='lower'
      labels={labels}
    />,
  );
  const choiceCell = view.match(
    /<button class="score-category-cell"[^>]*data-score-category="choice"[\s\S]*?<\/button>/u,
  )?.[0];

  expect(view).toContain('data-mode="opponent-turn"');
  expect(choiceCell).toContain('data-value-state="recorded"');
  expect(choiceCell).toContain('>7<');
  expect(choiceCell).not.toContain('>19<');
});

test('uses injected HUD content and distinguishes an empty presence slot from the fallback', () => {
  const props = {
    model,
    categories,
    labels: { ...labels, presence: 'Fallback connection notice' },
    rollAction: { label: 'Roll again', readOnly: false },
    scoreDisplay: {
      owner: 'viewer' as const,
      showFirstRollGuide: false,
    },
    summaryPlayer: { imageAlt: 'You', label: 'You' },
    bonusEarned: false,
    activeGroup: 'upper' as const,
  };
  const view = renderToStaticMarkup(<GameBoard {...props} />);
  expect(view).toContain('Fallback connection notice');
  expect(view).toContain('52 seconds');
  const utils = renderToStaticMarkup(
    <GameBoard {...props} presenceContent={null} timerContent={<strong>Injected timer</strong>} />,
  );
  expect(utils).not.toContain('Fallback connection notice');
  expect(utils).not.toContain('52 seconds');
  expect(utils).toContain('Injected timer');
});

test('preserves actual roll and hold authority through a score display owner change', () => {
  const intents: string[] = [];
  const props: GameBoardProps = {
    model: {
      ...model,
      scoreRows: model.scoreRows.map((row) =>
        row.categoryId === 'choice'
          ? { ...row, viewerScore: null, opponentScore: 20, previewScore: 24, selectable: true }
          : row.categoryId === 'yacht'
            ? { ...row, viewerScore: 0, opponentScore: 50, previewScore: null, selectable: false }
            : row,
      ),
    },
    scoreDisplay: { owner: 'viewer', showFirstRollGuide: false },
    summaryPlayer: { imageUrl: '/same-avatar.webp', imageAlt: 'You', label: 'You' },
    bonusEarned: false,
    categories,
    activeGroup: 'lower',
    labels,
    rollAction: { label: 'Roll again', readOnly: false },
    onRoll: () => intents.push('roll'),
    onSetDieHeld: (slot, held) => intents.push(`hold:${slot}:${held}`),
    onSelectScore: (categoryId) => intents.push(`score:${categoryId}`),
  };
  const { rerender } = render(<GameBoard {...props} />);
  const cell = screen.getByRole('button', { name: 'choice · 24' });
  const roll = screen.getByRole('button', { name: 'Roll again' });
  const held = screen.getByRole('button', { name: 'Held dice 1: 1' });
  fireEvent.click(roll);
  fireEvent.click(held);
  rerender(
    <GameBoard
      {...props}
      scoreDisplay={{ owner: 'opponent', showFirstRollGuide: false }}
      summaryPlayer={{ imageUrl: '/same-avatar.webp', imageAlt: 'Opponent', label: 'Opponent' }}
    />,
  );
  expect(screen.getByRole('button', { name: 'choice · 20' })).toBe(cell);
  expect(screen.getByRole('button', { name: 'Roll again' })).toBe(roll);
  expect(screen.getByRole('button', { name: 'Held dice 1: 1' })).toBe(held);
  expect(cell.getAttribute('data-input-available')).toBe('true');
  fireEvent.click(roll);
  fireEvent.click(held);
  fireEvent.click(cell);
  expect(intents).toEqual(['roll', 'hold:0:false', 'roll', 'hold:0:false', 'score:choice']);
});

test('can retain a recorder score panel without restoring the previous first-roll guide', () => {
  const view = renderToStaticMarkup(
    <GameBoard
      model={{ ...model, turn: { ...model.turn!, showFirstRollGuide: true } }}
      scoreDisplay={{
        owner: 'opponent',
        showFirstRollGuide: false,
      }}
      summaryPlayer={{ imageAlt: 'Opponent', label: '상대' }}
      bonusEarned={false}
      categories={categories}
      activeGroup='lower'
      labels={labels}
      rollAction={{ label: 'Roll again', readOnly: false }}
    />,
  );
  expect(view).not.toContain('First roll guide');
  expect(view).toContain('>상대</strong>');
});
