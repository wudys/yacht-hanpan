import { type CategoryId, LOWER_CATEGORY_IDS, UPPER_CATEGORY_IDS } from '@repo/yacht-rules';

import type { ScoreRowViewModel } from '@/features/game/view/game-view-model';
import { ScoreCategoryCell } from '@/features/game/view/score/ScoreCategoryCell';
import type {
  CategoryLabels,
  ScoreCellDisplay,
  ScoreCellInput,
  ScoreDisplayOwner,
  ScoreGridMode,
  ScoreRecordFeedback,
} from '@/features/game/view/score/types';

export type ScoreGridProps = Readonly<{
  recordFeedback?: ScoreRecordFeedback | null;
  yachtAvailable?: boolean;
  rows: readonly ScoreRowViewModel[];
  displayOwner: ScoreDisplayOwner;
  categories: CategoryLabels;
  activeGroup: 'upper' | 'lower';
  mode: ScoreGridMode;
  labels: Readonly<{
    upper: string;
    lower: string;
    highestUpper: string | null;
    highestLower: string | null;
    emptyValue: string;
  }>;
  interactionLocked?: boolean;
  onGroupChange?: (group: 'upper' | 'lower') => void;
  onSelect?: (categoryId: CategoryId) => void;
  onBlockedSelect?: (categoryId: CategoryId) => void;
}>;

export function ScoreGrid({
  rows,
  recordFeedback,
  yachtAvailable = false,
  displayOwner,
  categories,
  activeGroup,
  mode,
  labels,
  interactionLocked = false,
  onGroupChange,
  onSelect,
  onBlockedSelect,
}: ScoreGridProps) {
  const categoryIds = activeGroup === 'upper' ? UPPER_CATEGORY_IDS : LOWER_CATEGORY_IDS;
  const rowsByCategory = new Map(rows.map((row) => [row.categoryId, row]));

  return (
    <section className='score-grid' data-score-grid='true' data-mode={mode}>
      <div className='score-group-tabs' role='tablist'>
        <button
          className='score-group-tab'
          type='button'
          role='tab'
          aria-selected={activeGroup === 'upper'}
          data-score-tab='upper'
          onClick={() => onGroupChange?.('upper')}
        >
          <strong>{labels.upper}</strong>
          {labels.highestUpper !== null ? <span>{labels.highestUpper}</span> : null}
        </button>
        <button
          className='score-group-tab'
          type='button'
          role='tab'
          aria-selected={activeGroup === 'lower'}
          data-score-tab='lower'
          onClick={() => onGroupChange?.('lower')}
        >
          <strong>{labels.lower}</strong>
          {labels.highestLower !== null ? <span>{labels.highestLower}</span> : null}
        </button>
      </div>
      <div className='score-grid__cells' role='tabpanel'>
        {categoryIds.map((categoryId) => {
          const row = rowsByCategory.get(categoryId);
          const recordedScore = displayOwner === 'viewer' ? row?.viewerScore : row?.opponentScore;
          const display: ScoreCellDisplay =
            recordedScore !== null && recordedScore !== undefined
              ? { state: 'recorded', value: recordedScore }
              : row?.previewScore !== null && row?.previewScore !== undefined
                ? { state: 'preview', value: row.previewScore }
                : { state: 'empty', value: null };
          const input: ScoreCellInput =
            mode !== 'viewer-turn' || row === undefined
              ? 'disabled'
              : row.viewerScore !== null
                ? 'recorded'
                : row.selectable
                  ? 'selectable'
                  : 'disabled';
          return row ? (
            <ScoreCategoryCell
              key={categoryId}
              categoryId={categoryId}
              recordFeedback={recordFeedback}
              yachtAvailable={categoryId === 'yacht' && yachtAvailable}
              display={display}
              input={input}
              label={categories[categoryId]}
              emptyValueLabel={labels.emptyValue}
              interactionLocked={interactionLocked}
              onSelect={onSelect}
              onBlockedSelect={onBlockedSelect}
            />
          ) : null;
        })}
      </div>
    </section>
  );
}
