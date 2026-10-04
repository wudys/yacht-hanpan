import { requireGameAsset } from '@repo/game-assets';
import { UPPER_BONUS_THRESHOLD } from '@repo/yacht-rules';

import type { ScoreRowViewModel } from '@/features/game/view/game-view-model';
import type { CategoryLabels, PlayerScoreSummaryView } from '@/features/game/view/score/types';
import { PlayerAvatar } from '@/ui/profile';

export type ScoreTableProps = Readonly<{
  rows: readonly ScoreRowViewModel[];
  categories: CategoryLabels;
  viewer: PlayerScoreSummaryView;
  opponent: PlayerScoreSummaryView;
  labels: Readonly<{ categoryHeader: string; upperSubtotal: string; bonus: string }>;
  viewerOutcome?: string;
  opponentOutcome?: string;
  winner?: 'viewer' | 'opponent' | null;
  showViewerMarker?: boolean;
}>;

export function ScoreTable({
  rows,
  categories,
  viewer,
  opponent,
  labels,
  viewerOutcome,
  opponentOutcome,
  winner = null,
  showViewerMarker = true,
}: ScoreTableProps) {
  return (
    <div className='score-table' data-score-table='true'>
      <div className='score-table__players'>
        <ScoreTablePlayer
          player={viewer}
          outcome={viewerOutcome}
          winner={winner === 'viewer'}
          labels={labels}
          viewer
          selfLabel={showViewerMarker ? viewer.label : undefined}
        />
        <ScoreTablePlayer
          player={opponent}
          outcome={opponentOutcome}
          winner={winner === 'opponent'}
          labels={labels}
        />
      </div>
      <table>
        <thead>
          <tr>
            <th scope='col'>{labels.categoryHeader}</th>
            <th scope='col'>{viewer.label}</th>
            <th scope='col'>{opponent.label}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.categoryId} data-score-row='true' data-score-category={row.categoryId}>
              <th scope='row'>
                <span className='score-table__category'>
                  <img src={requireGameAsset(`score.${row.categoryId}`).url} alt='' />
                  <span>{categories[row.categoryId]}</span>
                </span>
              </th>
              <ScoreValue value={row.viewerScore} />
              <ScoreValue value={row.opponentScore} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScoreTablePlayer({
  player,
  outcome,
  winner,
  labels,
  viewer = false,
  selfLabel,
}: Readonly<{
  player: PlayerScoreSummaryView;
  outcome?: string;
  winner: boolean;
  labels: ScoreTableProps['labels'];
  viewer?: boolean;
  selfLabel?: string;
}>) {
  return (
    <section
      className='score-table-player'
      data-score-player={viewer ? 'viewer' : 'opponent'}
      data-winner={winner ? 'true' : 'false'}
    >
      <div className='score-table-player__avatar'>
        <PlayerAvatar
          imageUrl={player.imageUrl}
          alt={player.imageAlt}
          size='md'
          winner={winner}
          selfLabel={selfLabel}
        />
        {winner ? (
          <img
            className='score-table-player__crown'
            data-result-crown='true'
            src={requireGameAsset('ui.crown').url}
            alt=''
          />
        ) : null}
      </div>
      <div className='score-table-player__heading'>
        <span className='score-table-player__label'>{player.label}</span>{' '}
        {outcome ? (
          <>
            <span className='score-table-player__separator' aria-hidden='true' />{' '}
            <strong>{outcome}</strong>
          </>
        ) : null}
      </div>
      <strong className='score-table-player__total'>{player.total}</strong>
      <span className='score-table-player__summary'>
        <span>
          {labels.upperSubtotal} {player.upperSubtotal}/{UPPER_BONUS_THRESHOLD}
        </span>{' '}
        <span className='score-table-player__separator' aria-hidden='true' />{' '}
        <span>
          {labels.bonus} {player.upperBonus}
        </span>
      </span>
    </section>
  );
}

function ScoreValue({ value }: Readonly<{ value: number | null }>) {
  return (
    <td data-score-state={value === null ? 'empty' : 'recorded'}>{value === null ? '—' : value}</td>
  );
}
