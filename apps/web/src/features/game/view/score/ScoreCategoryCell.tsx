import { requireGameAsset } from '@repo/game-assets';
import type { CategoryId } from '@repo/yacht-rules';

import type { ScoreRowViewModel } from '@/features/game/view/game-view-model';
import type { ScoreGridMode } from '@/features/game/view/score/types';

export type ScoreCategoryCellProps = Readonly<{
  row: ScoreRowViewModel;
  label: string;
  mode: ScoreGridMode;
  emptyValueLabel: string;
  interactionLocked?: boolean;
  onSelect?: (categoryId: CategoryId) => void;
  onBlockedSelect?: (categoryId: CategoryId) => void;
}>;

export function ScoreCategoryCell({
  row,
  label,
  mode,
  emptyValueLabel,
  interactionLocked = false,
  onSelect,
  onBlockedSelect,
}: ScoreCategoryCellProps) {
  const recordedScore = mode === 'opponent-turn' ? row.opponentScore : row.viewerScore;
  const value =
    recordedScore ??
    (mode === 'viewer-turn' && row.previewScore !== null ? row.previewScore : null);
  const valueState =
    recordedScore !== null
      ? 'recorded'
      : mode === 'viewer-turn' && row.previewScore !== null
        ? 'preview'
        : 'empty';
  const selectable =
    mode === 'viewer-turn' && row.viewerScore === null && row.selectable && !interactionLocked;
  const recordedSelectionBlocked =
    mode === 'viewer-turn' && row.viewerScore !== null && !interactionLocked;

  return (
    <button
      className='score-category-cell'
      type='button'
      data-score-cell='true'
      data-score-category={row.categoryId}
      data-mode={mode}
      data-value-state={valueState}
      data-input-available={selectable}
      aria-label={`${label} · ${value ?? emptyValueLabel}`}
      data-interaction-locked={
        mode === 'viewer-turn' && row.viewerScore === null && row.selectable && interactionLocked
          ? 'true'
          : 'false'
      }
      disabled={!selectable && !recordedSelectionBlocked && !interactionLocked}
      aria-disabled={!selectable}
      onClick={() => {
        if (selectable) {
          onSelect?.(row.categoryId);
        } else if (recordedSelectionBlocked) {
          onBlockedSelect?.(row.categoryId);
        }
      }}
    >
      <img
        className='score-category-cell__icon'
        src={requireGameAsset(`score.${row.categoryId}`).url}
        alt=''
      />
      <span className='score-category-cell__label'>{label}</span>
      <span className='score-category-cell__value' data-score-value-kind={valueState}>
        {value}
      </span>
    </button>
  );
}
