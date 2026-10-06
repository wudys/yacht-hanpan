import { requireGameAsset } from '@repo/game-assets';
import { type DieFace as DieFaceValue } from '@repo/yacht-rules';
import { memo, type ReactNode, useMemo } from 'react';

import { GamePresence } from '@/features/game/view/board/GamePresence';
import { GameTimer } from '@/features/game/view/board/GameTimer';
import { PlayerSummary, type PlayerSummaryProps } from '@/features/game/view/board/PlayerSummary';
import { type TurnCueFeedback, TurnStartCue } from '@/features/game/view/board/TurnStartCue';
import type { DiceSlotViewModel, GameViewModel } from '@/features/game/view/game-view-model';
import {
  type CategoryLabels,
  type ScoreDisplayOwner,
  ScoreGrid,
  type ScoreGridMode,
  type ScoreRecordFeedback,
} from '@/features/game/view/score';
import { Button, IconButton } from '@/ui/button';

const MemoPlayerSummary = memo(PlayerSummary);
const MemoScoreGrid = memo(ScoreGrid);

export type GameBoardProps = Readonly<{
  model: Pick<GameViewModel, 'turn' | 'scoreRows' | 'actions'>;
  rollAction: Readonly<{ label: string; readOnly: boolean }>;
  scoreDisplay: Readonly<{
    owner: ScoreDisplayOwner;
    showFirstRollGuide: boolean;
  }>;
  recordFeedback?: ScoreRecordFeedback | null;
  yachtAvailable?: boolean;
  turnCue?: TurnCueFeedback | null;
  turnCueLabel?: string;
  summaryPlayer: PlayerSummaryProps['player'];
  bonusEarned: boolean;
  categories: CategoryLabels;
  activeGroup: 'upper' | 'lower';
  labels: Readonly<{
    turn: string;
    timer: string;
    settings: string;
    diceStage: string;
    heldDice: string;
    rollsRemaining: string;
    total: string;
    bonus: string;
    bonusStatus: string;
    bonusInfo: string;
    scoreboard: string;
    upper: string;
    lower: string;
    highestUpper: string | null;
    highestLower: string | null;
    firstRollGuide: string;
    emptyScore: string;
    presence?: string;
  }>;
  diceStage?: ReactNode;
  bonusPopover?: ReactNode;
  rolling?: boolean;
  rollRailHidden?: boolean;
  physicsArea?: ReactNode;
  interactionLocked?: boolean;
  rollPending?: boolean;
  rollProgress?: ReactNode;
  timerWarning?: boolean;
  timerContent?: ReactNode;
  presenceContent?: ReactNode;
  onRoll?: () => void;
  onSetDieHeld?: (slot: DiceSlotViewModel['slot'], isHeld: boolean) => void;
  onSelectScore?: (categoryId: GameViewModel['scoreRows'][number]['categoryId']) => void;
  onBlockedScore?: (categoryId: GameViewModel['scoreRows'][number]['categoryId']) => void;
  onScoreGroupChange?: (group: 'upper' | 'lower') => void;
  onOpenScoreboard?: () => void;
  onOpenBonus?: () => void;
  onOpenSettings?: () => void;
}>;

const DIE_SLOTS = [0, 1, 2, 3, 4] as const;
const DIE_PIPS: Readonly<Record<DieFaceValue, readonly number[]>> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

const DieFace = memo(function DieFace({ value }: Readonly<{ value: DieFaceValue }>) {
  const pips = DIE_PIPS[value];

  return (
    <span className='held-die-face' data-die-face={value} aria-hidden='true'>
      {Array.from({ length: 9 }, (_, position) => (
        <span
          className={pips.includes(position) ? 'held-die-face__pip' : undefined}
          data-die-pip={pips.includes(position) ? 'true' : undefined}
          key={position}
        />
      ))}
    </span>
  );
});

export function GameBoard({
  model,
  rollAction,
  summaryPlayer,
  scoreDisplay,
  recordFeedback,
  yachtAvailable = false,
  turnCue,
  turnCueLabel = '',
  bonusEarned,
  categories,
  activeGroup,
  labels,
  diceStage,
  bonusPopover,
  rolling = false,
  rollRailHidden = rolling,
  physicsArea,
  interactionLocked = false,
  rollPending = false,
  rollProgress,
  timerWarning = false,
  timerContent,
  presenceContent,
  onRoll,
  onSetDieHeld,
  onSelectScore,
  onBlockedScore,
  onScoreGroupChange,
  onOpenScoreboard,
  onOpenBonus,
  onOpenSettings,
}: GameBoardProps) {
  const summaryLabels = useMemo(
    () => ({
      total: labels.total,
      bonus: labels.bonus,
      bonusStatus: labels.bonusStatus,
      bonusInfo: labels.bonusInfo,
      scoreboard: labels.scoreboard,
    }),
    [labels.total, labels.bonus, labels.bonusStatus, labels.bonusInfo, labels.scoreboard],
  );
  const scoreLabels = useMemo(
    () => ({
      upper: labels.upper,
      lower: labels.lower,
      highestUpper: labels.highestUpper,
      highestLower: labels.highestLower,
      emptyValue: labels.emptyScore,
    }),
    [labels.upper, labels.lower, labels.highestUpper, labels.highestLower, labels.emptyScore],
  );
  const { turn } = model;
  const { dice = [] } = turn ?? {};
  const heldDice = (turn?.heldSlots ?? []).map((slot) => dice[slot]!);
  const scoreMode: ScoreGridMode =
    turn === null
      ? 'disabled'
      : !turn.isViewerTurn
        ? 'opponent-turn'
        : dice.length === 0
          ? 'disabled'
          : 'viewer-turn';

  return (
    <main
      className='game-board'
      data-product-view='game'
      data-viewer-turn={turn?.isViewerTurn ? 'true' : 'false'}
    >
      <header className='game-board__top' data-game-band='top'>
        <strong className='game-board__turn'>{labels.turn}</strong>
        {presenceContent === undefined ? (
          <GamePresence message={labels.presence} />
        ) : (
          presenceContent
        )}
        {timerContent === undefined ? (
          <GameTimer label={labels.timer} warning={timerWarning} />
        ) : (
          timerContent
        )}
        <IconButton
          label={labels.settings}
          icon={<img src={requireGameAsset('ui.settings').url} alt='' />}
          onClick={onOpenSettings}
        />
      </header>

      <section className='dice-board' data-game-band='dice' data-rolling={rolling}>
        {turnCue ? (
          <TurnStartCue key={turnCue.identity} cue={turnCue} label={turnCueLabel} />
        ) : null}
        {rolling ? physicsArea : null}
        <div className='held-dice-rack' aria-label={labels.heldDice}>
          {DIE_SLOTS.map((slot) => {
            const die = heldDice[slot];
            return (
              <button
                className='held-dice-rack__slot'
                type='button'
                key={slot}
                data-held-slot={die?.slot ?? `empty-${slot}`}
                data-held={die?.held ? 'true' : 'false'}
                data-interaction-locked={
                  die?.held && model.actions.canHold && interactionLocked ? 'true' : 'false'
                }
                aria-pressed={die?.held ?? false}
                aria-label={die ? `${labels.heldDice} ${die.slot + 1}: ${die.value}` : undefined}
                aria-hidden={!die || undefined}
                disabled={!die?.held || !model.actions.canHold || interactionLocked}
                onClick={() => {
                  if (die?.held && model.actions.canHold && !interactionLocked) {
                    onSetDieHeld?.(die.slot, false);
                  }
                }}
              >
                {die?.held ? <DieFace value={die.value} /> : null}
              </button>
            );
          })}
        </div>
        <div className='dice-stage-slot' data-dice-stage-slot='true' aria-label={labels.diceStage}>
          {diceStage}
        </div>
        <div
          className='roll-action-rail'
          data-roll-rail-hidden={rollRailHidden ? 'true' : 'false'}
          aria-hidden={rollRailHidden || undefined}
        >
          {rollAction.readOnly ? (
            <div className='roll-status' role='status' aria-busy={rollPending || undefined}>
              <span className='roll-status__label'>{rollAction.label}</span>
              {rollProgress !== null && rollProgress !== undefined ? (
                <span className='ui-button__progress' aria-hidden='true'>
                  {rollProgress}
                </span>
              ) : null}
            </div>
          ) : (
            <Button
              label={rollAction.label}
              disabled={!model.actions.canRoll}
              interactionLocked={interactionLocked}
              busy={rollPending}
              progress={rollProgress}
              preserveLabelOnProgress
              onClick={onRoll}
            />
          )}
          <span className='status-pill'>{labels.rollsRemaining}</span>
        </div>
      </section>

      <div className='game-board__scoring-panel'>
        <MemoPlayerSummary
          player={summaryPlayer}
          recordFeedback={recordFeedback}
          labels={summaryLabels}
          displayOwner={scoreDisplay.owner}
          bonusEarned={bonusEarned}
          bonusPopover={bonusPopover}
          onOpenBonus={onOpenBonus}
          onOpenScoreboard={onOpenScoreboard}
        />

        <section className='game-board__score' data-game-band='score'>
          {scoreDisplay.showFirstRollGuide ? (
            <p className='game-board__first-roll-guide'>{labels.firstRollGuide}</p>
          ) : null}
          <MemoScoreGrid
            recordFeedback={recordFeedback}
            yachtAvailable={yachtAvailable}
            rows={model.scoreRows}
            displayOwner={scoreDisplay.owner}
            categories={categories}
            activeGroup={activeGroup}
            mode={scoreMode}
            labels={scoreLabels}
            interactionLocked={interactionLocked}
            onGroupChange={onScoreGroupChange}
            onSelect={onSelectScore}
            onBlockedSelect={onBlockedScore}
          />
        </section>
      </div>
    </main>
  );
}
