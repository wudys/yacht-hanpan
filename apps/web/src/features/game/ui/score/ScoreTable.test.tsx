import { CATEGORY_IDS } from '@repo/yacht-rules';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import type { ScoreRowViewModel } from '@/features/game/ui/game-view-model';
import { ScoreTable } from '@/features/game/ui/score/ScoreTable';
import type { CategoryLabels, PlayerScoreSummaryView } from '@/features/game/ui/score/types';

const categories = Object.fromEntries(
  CATEGORY_IDS.map((categoryId) => [categoryId, categoryId]),
) as CategoryLabels;
const rows: readonly ScoreRowViewModel[] = CATEGORY_IDS.map((categoryId, index) => ({
  categoryId,
  viewerScore: index === 0 ? 0 : null,
  opponentScore: index === 1 ? 4 : null,
  previewScore: null,
  selectable: false,
}));
const viewer: PlayerScoreSummaryView = {
  label: 'You',
  imageUrl: '/you.png',
  imageAlt: 'You',
  total: 0,
  upperSubtotal: 0,
  upperBonus: 0,
};
const opponent: PlayerScoreSummaryView = {
  label: 'Opponent',
  imageUrl: '/opponent.png',
  imageAlt: 'Opponent',
  total: 4,
  upperSubtotal: 4,
  upperBonus: 0,
};

test('renders each authoritative category exactly once', () => {
  const view = renderToStaticMarkup(
    <ScoreTable
      rows={rows}
      categories={categories}
      viewer={viewer}
      opponent={opponent}
      labels={{ categoryHeader: 'Category', upperSubtotal: 'Upper', bonus: 'Bonus' }}
    />,
  );

  const renderedCategories = [...view.matchAll(/data-score-category="([^"]+)"/gu)].map(
    (match) => match[1],
  );
  expect(renderedCategories).toEqual(CATEGORY_IDS);
});

test('distinguishes an unrecorded value from a recorded zero', () => {
  const view = renderToStaticMarkup(
    <ScoreTable
      rows={rows}
      categories={categories}
      viewer={viewer}
      opponent={opponent}
      labels={{ categoryHeader: 'Category', upperSubtotal: 'Upper', bonus: 'Bonus' }}
    />,
  );

  expect(view).toContain('data-score-category="ones"');
  expect(view).toContain('data-score-state="recorded">0</td>');
  expect(view).toContain('data-score-state="empty">—</td>');
});
