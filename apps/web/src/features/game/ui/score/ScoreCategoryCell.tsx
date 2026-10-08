import { requireGameAsset } from '@repo/game-assets';
import type { CategoryId } from '@repo/yacht-rules';

import {
  RecordTransition,
  ScoreRecordEffect,
  YachtRing,
} from '@/features/game/ui/score/ScoreFeedbackEffects';
import type {
  ScoreCellDisplay,
  ScoreCellInput,
  ScoreRecordFeedback,
} from '@/features/game/ui/score/types';

export type ScoreCategoryCellProps = Readonly<{
  recordFeedback?: ScoreRecordFeedback | null;
  yachtAvailable?: boolean;
  categoryId: CategoryId;
  display: ScoreCellDisplay;
  input: ScoreCellInput;
  label: string;
  emptyValueLabel: string;
  interactionLocked?: boolean;
  onSelect?: (categoryId: CategoryId) => void;
  onBlockedSelect?: (categoryId: CategoryId) => void;
}>;

export function ScoreCategoryCell({
  categoryId,
  recordFeedback,
  yachtAvailable = false,
  display,
  input,
  label,
  emptyValueLabel,
  interactionLocked = false,
  onSelect,
  onBlockedSelect,
}: ScoreCategoryCellProps) {
  const { value, state: valueState } = display;
  const confirmed =
    recordFeedback !== null &&
    recordFeedback !== undefined &&
    recordFeedback.phase !== 'incoming' &&
    recordFeedback.categoryId === categoryId;
  const selectable = input === 'selectable' && !interactionLocked;
  const recordedSelectionBlocked = input === 'recorded' && !interactionLocked;

  return (
    <button
      className='score-category-cell'
      type='button'
      data-score-cell='true'
      data-score-category={categoryId}
      data-score-confirmed={confirmed || undefined}
      data-yacht-available={yachtAvailable || undefined}
      data-value-state={valueState}
      data-input-available={selectable}
      aria-label={`${label} · ${value ?? emptyValueLabel}`}
      data-interaction-locked={input === 'selectable' && interactionLocked ? 'true' : 'false'}
      disabled={!selectable && !recordedSelectionBlocked && !interactionLocked}
      aria-disabled={!selectable}
      onClick={() => {
        if (selectable) {
          onSelect?.(categoryId);
        } else if (recordedSelectionBlocked) {
          onBlockedSelect?.(categoryId);
        }
      }}
    >
      <img
        className='score-category-cell__icon'
        src={requireGameAsset(`score.${categoryId}`).url}
        alt=''
      />
      <span className='score-category-cell__label'>{label}</span>
      <RecordTransition
        key={`${recordFeedback?.identity ?? 'idle'}:${recordFeedback?.phase ?? 'idle'}`}
        feedback={recordFeedback}
        className='score-category-cell__value'
        data-score-value-kind={valueState}
      >
        {value}
      </RecordTransition>
      {confirmed && recordFeedback ? (
        <ScoreRecordEffect key={recordFeedback.identity} feedback={recordFeedback} />
      ) : null}
      {yachtAvailable && !confirmed ? <YachtRing /> : null}
    </button>
  );
}
