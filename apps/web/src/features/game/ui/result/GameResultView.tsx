import type { ScoreRowViewModel } from '@/features/game/ui/game-view-model';
import {
  type CategoryLabels,
  type PlayerScoreSummaryView,
  ScoreTable,
} from '@/features/game/ui/score';
import { Button } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

export type GameResultReason =
  | Readonly<{ kind: 'normal' }>
  | Readonly<{ kind: 'forfeit' | 'timeout' | 'connection-ended'; text: string }>;

export type GameResultViewProps = Readonly<{
  rows: readonly ScoreRowViewModel[];
  viewer: PlayerScoreSummaryView;
  opponent: PlayerScoreSummaryView;
  categories: CategoryLabels;
  outcome: 'viewer-win' | 'opponent-win' | 'draw';
  reason: GameResultReason;
  labels: Readonly<{
    title: string;
    categoryHeader: string;
    upperSubtotal: string;
    bonus: string;
    win: string;
    loss: string;
    draw: string;
    backToLobby: string;
  }>;
  onBackToLobby?: () => void;
}>;

export function GameResultView({
  rows,
  viewer,
  opponent,
  categories,
  outcome,
  reason,
  labels,
  onBackToLobby,
}: GameResultViewProps) {
  const winner =
    outcome === 'viewer-win' ? 'viewer' : outcome === 'opponent-win' ? 'opponent' : null;

  return (
    <main
      className='game-result-view score-layer-frame'
      data-product-view='result'
      data-result-outcome={outcome}
      data-winner={winner ?? 'none'}
    >
      <ScrollablePanel
        title={labels.title}
        footer={<Button label={labels.backToLobby} variant='primary' onClick={onBackToLobby} />}
      >
        <div className='game-result-view__content'>
          {reason.kind === 'normal' ? null : (
            <p className='game-result-view__reason' data-result-reason={reason.kind}>
              {reason.text}
            </p>
          )}
          <ScoreTable
            rows={rows}
            categories={categories}
            viewer={viewer}
            opponent={opponent}
            labels={{
              categoryHeader: labels.categoryHeader,
              upperSubtotal: labels.upperSubtotal,
              bonus: labels.bonus,
            }}
            viewerOutcome={
              winner === null ? labels.draw : winner === 'viewer' ? labels.win : labels.loss
            }
            opponentOutcome={
              winner === null ? labels.draw : winner === 'opponent' ? labels.win : labels.loss
            }
            winner={winner}
            showViewerMarker={false}
          />
        </div>
      </ScrollablePanel>
    </main>
  );
}
