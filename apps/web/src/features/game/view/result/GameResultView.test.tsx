import { CATEGORY_IDS } from '@repo/yacht-rules';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import type { ScoreRowViewModel } from '@/features/game/view/game-view-model';
import {
  GameResultView,
  type GameResultViewProps,
} from '@/features/game/view/result/GameResultView';
import type { CategoryLabels, PlayerScoreSummaryView } from '@/features/game/view/score';

const categories = Object.fromEntries(
  CATEGORY_IDS.map((categoryId) => [categoryId, categoryId]),
) as CategoryLabels;
const rows: readonly ScoreRowViewModel[] = CATEGORY_IDS.map((categoryId, index) => ({
  categoryId,
  viewerScore: index === 0 ? 0 : null,
  opponentScore: null,
  previewScore: null,
  selectable: false,
}));
const viewer: PlayerScoreSummaryView = {
  label: 'You',
  imageUrl: '/you.webp',
  imageAlt: 'You',
  total: 100,
  upperSubtotal: 42,
  upperBonus: 0,
};
const opponent: PlayerScoreSummaryView = {
  label: 'Opponent',
  imageUrl: '/opponent.webp',
  imageAlt: 'Opponent',
  total: 80,
  upperSubtotal: 38,
  upperBonus: 0,
};
const labels: GameResultViewProps['labels'] = {
  title: 'Result',
  categoryHeader: 'Category',
  upperSubtotal: 'Upper',
  bonus: 'Bonus',
  win: 'Win',
  loss: 'Loss',
  draw: 'Draw',

  backToLobby: 'Back',
};

test.each(['viewer-win', 'opponent-win'] as const)(
  'shows only the authoritative winner accent for %s and omits turn metadata',
  (outcome) => {
    const view = renderToStaticMarkup(
      <GameResultView
        rows={rows}
        viewer={viewer}
        opponent={opponent}
        categories={categories}
        outcome={outcome}
        reason={{ kind: 'normal' }}
        labels={labels}
      />,
    );

    expect(view.match(/data-result-crown=/g)?.length).toBe(1);
    for (const player of ['viewer', 'opponent']) {
      const section = [
        ...view.matchAll(/data-score-player="(viewer|opponent)"[^]*?<\/section>/g),
      ].find((match) => match[1] === player)?.[0];
      expect(section).toContain(`<strong>${outcome === `${player}-win` ? 'Win' : 'Loss'}</strong>`);
    }
    expect(view).toContain(`data-winner="${outcome === 'viewer-win' ? 'viewer' : 'opponent'}"`);
    expect(view).not.toContain('data-result-turn');
    expect(view).not.toContain('data-result-reason');
    expect(view.match(/data-score-row=/g)?.length).toBe(12);
  },
);

test('renders a draw without a crown or winner accent', () => {
  const view = renderToStaticMarkup(
    <GameResultView
      rows={rows}
      viewer={viewer}
      opponent={opponent}
      categories={categories}
      outcome='draw'
      reason={{ kind: 'normal' }}
      labels={labels}
    />,
  );

  expect(view).not.toContain('data-result-crown');
  expect(view).toContain('data-winner="none"');
  expect(view.match(/<strong>Draw<\/strong>/g)).toHaveLength(2);
});

test('shows the supplied text for an explicit abnormal result', () => {
  const view = renderToStaticMarkup(
    <GameResultView
      rows={rows}
      viewer={viewer}
      opponent={opponent}
      categories={categories}
      outcome='viewer-win'
      reason={{ kind: 'forfeit', text: 'Supplied result reason' }}
      labels={labels}
    />,
  );

  expect(view).toContain('data-result-reason="forfeit">Supplied result reason</p>');
});

test('places an abnormal result reason before the player outcomes and category scores', () => {
  const view = renderToStaticMarkup(
    <GameResultView
      rows={rows}
      viewer={viewer}
      opponent={opponent}
      categories={categories}
      outcome='viewer-win'
      reason={{ kind: 'forfeit', text: 'Forfeit reason' }}
      labels={labels}
    />,
  );

  const players = view.indexOf('class="score-table__players"');
  const reason = view.indexOf('data-result-reason="forfeit"');
  const scores = view.indexOf('data-score-row="true"');
  expect(players).toBeGreaterThan(-1);
  expect(reason).toBeGreaterThan(-1);
  expect(players).toBeGreaterThan(reason);
  expect(scores).toBeGreaterThan(players);
});
