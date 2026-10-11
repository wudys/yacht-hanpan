import { ScoreTable, type ScoreTableProps } from '@/features/game/ui/score/ScoreTable';
import { Button } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

export type GameScoreboardViewProps = Pick<
  ScoreTableProps,
  'rows' | 'categories' | 'viewer' | 'opponent' | 'labels'
> &
  Readonly<{
    title: string;
    turnLabel: string;
    closeLabel: string;
    onClose: () => void;
  }>;

export function GameScoreboardView({
  rows,
  categories,
  viewer,
  opponent,
  labels,
  title,
  turnLabel,
  closeLabel,
  onClose,
}: GameScoreboardViewProps) {
  return (
    <ScrollablePanel
      title={title}
      meta={turnLabel}
      footer={<Button label={closeLabel} variant='secondary' onClick={onClose} />}
    >
      <ScoreTable
        rows={rows}
        categories={categories}
        viewer={viewer}
        opponent={opponent}
        labels={labels}
      />
    </ScrollablePanel>
  );
}
