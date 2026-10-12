import { requireGameAsset, resolveCharacterImageAssetId } from '@repo/game-assets';
import type { GameSnapshot, PublicRoom } from '@repo/game-protocol/state';
import {
  CATEGORY_IDS,
  findSpecialCombinations,
  MAX_ROLLS_PER_TURN,
  type SeatIndex,
  SPECIAL_COMBINATION,
} from '@repo/yacht-rules';

import type { TurnFeedbackSnapshot } from '@/features/game/feedback/use-turn-feedback';
import type {
  CategoryLabels,
  GameBoardProps,
  GameResultViewProps,
  GameViewModel,
  PlayerScoreSummaryView,
} from '@/features/game/ui';
import { type Locale, type MessageKeyWithoutParams, translate } from '@/i18n';
import type { DicePresentationSnapshot } from '@/runtime/dice/dice-presentation-controller';

function createGameFeedbackPresentation({
  turn,
  viewerSeatIndex,
  record,
}: Readonly<{
  turn: GameViewModel['turn'];
  viewerSeatIndex: SeatIndex | null;
  record: TurnFeedbackSnapshot['record'];
}>): Pick<GameBoardProps, 'scoreDisplay' | 'recordFeedback'> {
  const summaryIsViewer =
    record !== null && (record.final || record.phase !== 'incoming')
      ? record.record.seatIndex === viewerSeatIndex
      : (turn?.isViewerTurn ?? true);
  return {
    scoreDisplay: {
      owner: summaryIsViewer ? 'viewer' : 'opponent',
      showFirstRollGuide: record === null && (turn?.showFirstRollGuide ?? false),
    },
    recordFeedback: record?.visible
      ? {
          identity: String(record.record.stateVersion),
          categoryId: record.record.categoryId,
          score: record.record.score,
          phase: record.phase,
          timing: { startedAt: record.startedAt },
          bonusEarned: record.bonusEarned,
        }
      : null,
  };
}

export function createCategoryLabels(locale: Locale): CategoryLabels {
  return Object.fromEntries(
    CATEGORY_IDS.map((categoryId) => [categoryId, translate(locale, `category.${categoryId}`)]),
  ) as CategoryLabels;
}

export function createGameScorePresentation(
  room: PublicRoom | null,
  model: Pick<GameViewModel, 'viewer' | 'opponent'>,
  locale: Locale,
) {
  const player = (score: GameViewModel['viewer'], label: string): PlayerScoreSummaryView => {
    const { seatIndex } = score;
    const profile = room?.seats[seatIndex]?.profile;
    return {
      label,
      imageAlt: label,
      imageUrl: profile
        ? requireGameAsset(resolveCharacterImageAssetId(profile.characterId, profile.variant)).url
        : undefined,
      total: score.total,
      upperSubtotal: score.upperSubtotal,
      upperBonus: score.upperBonus,
    };
  };
  return {
    viewer: player(model.viewer, translate(locale, 'game.you')),
    opponent: player(model.opponent, translate(locale, 'game.opponent')),
    categories: createCategoryLabels(locale),
    scoreLabels: {
      categoryHeader: translate(locale, 'game.category'),
      upperSubtotal: translate(locale, 'game.upper'),
      bonus: translate(locale, 'game.bonus'),
    },
  };
}

export type GameScorePresentation = ReturnType<typeof createGameScorePresentation>;

/** Projects compact-board content without changing authority, input eligibility or feedback time. */
export function createGameBoardPresentation({
  model,
  scores,
  viewerSeatIndex,
  record,
  turnCue,
  locale,
}: Readonly<{
  model: GameViewModel;
  scores: GameScorePresentation;
  viewerSeatIndex: SeatIndex;
  record: TurnFeedbackSnapshot['record'];
  turnCue: TurnFeedbackSnapshot['turnCue'];
  locale: Locale;
}>) {
  const { turn, scoreGroupPreviews } = model;
  const feedback = createGameFeedbackPresentation({ turn, viewerSeatIndex, record });
  const summary = scores[feedback.scoreDisplay.owner];
  const bonusEarned = summary.upperBonus > 0;
  const readOnly = turn !== null && (!turn.isViewerTurn || turn.rollCount === MAX_ROLLS_PER_TURN);
  const highest = (value: number | null): string | null =>
    value === null ? null : `${translate(locale, 'game.highest')} ${value}`;
  return {
    bonusSubtotal: summary.upperSubtotal,
    board: {
      model,
      ...feedback,
      rollAction: { label: translate(locale, rollActionLabel(turn)), readOnly },
      summaryPlayer: {
        imageUrl: summary.imageUrl,
        imageAlt: summary.imageAlt,
        label: summary.label,
      },
      bonusEarned,
      categories: scores.categories,
      turnCue:
        turnCue === null
          ? null
          : { identity: turnCue.turnId, timing: { startedAt: turnCue.startedAt } },
      turnCueLabel: translate(locale, 'game.turnStartCue'),
      labels: {
        turn: `${translate(locale, 'game.turn')} ${turn?.ordinal ?? '—'}/${turn?.total ?? '—'}`,
        settings: translate(locale, 'game.settings'),
        diceStage: translate(locale, 'game.diceStage'),
        heldDice: translate(locale, 'game.diceControls'),
        rollsRemaining: translate(locale, 'game.rollsRemaining', {
          count: MAX_ROLLS_PER_TURN - (turn?.rollCount ?? 0),
        }),
        total: `${translate(locale, 'game.total')} ${summary.total}`,
        bonus: translate(locale, 'game.bonus'),
        bonusStatus: translate(locale, bonusEarned ? 'game.bonusEarned' : 'game.bonusNotEarned'),
        bonusInfo: translate(locale, 'game.bonusInfo'),
        scoreboard: translate(locale, 'game.view.scoreboard'),
        upper: translate(locale, 'game.upper'),
        lower: translate(locale, 'game.lower'),
        highestUpper: highest(scoreGroupPreviews.upper),
        highestLower: highest(scoreGroupPreviews.lower),
        firstRollGuide: translate(locale, 'game.firstRollGuide'),
        emptyScore: translate(locale, 'game.emptyScore'),
      } satisfies GameBoardProps['labels'],
    },
  };
}

function rollActionLabel(turn: GameViewModel['turn']): MessageKeyWithoutParams {
  if (!turn?.isViewerTurn) return 'game.opponentTurn';
  if (turn.rollCount === 0) return 'game.roll';
  if (turn.rollCount === MAX_ROLLS_PER_TURN) return 'game.rollComplete';
  return 'game.reroll';
}

export function isUnrecordedYachtAvailable(
  game: GameSnapshot | null,
  phase: DicePresentationSnapshot['phase'],
  rollPending: boolean,
): boolean {
  if (rollPending || game?.match.status !== 'playing') return false;
  if (phase !== 'achievement' && phase !== 'settled') return false;
  const { currentTurn, players } = game.match;
  if (currentTurn.dice === null || players[currentTurn.seatIndex].scorecard.yacht !== undefined)
    return false;
  const { dice } = currentTurn;
  return findSpecialCombinations([
    dice[0].value,
    dice[1].value,
    dice[2].value,
    dice[3].value,
    dice[4].value,
  ]).includes(SPECIAL_COMBINATION.YACHT);
}

export function createResultPresentation(
  result: Extract<GameSnapshot['match'], { status: 'finished' }>['result'],
  viewerSeatIndex: SeatIndex,
  locale: Locale,
): Pick<GameResultViewProps, 'outcome' | 'reason' | 'labels'> {
  const outcome =
    result.winnerSeatIndex === null
      ? 'draw'
      : result.winnerSeatIndex === viewerSeatIndex
        ? 'viewer-win'
        : 'opponent-win';
  return {
    outcome,
    reason: resultReason(result.reason, locale),
    labels: {
      title: translate(locale, 'game.view.result'),
      categoryHeader: translate(locale, 'game.category'),
      upperSubtotal: translate(locale, 'game.upper'),
      bonus: translate(locale, 'game.bonus'),
      win: translate(locale, 'game.win'),
      loss: translate(locale, 'game.loss'),
      draw: translate(locale, 'game.draw'),
      backToLobby: translate(locale, 'game.backToLobby'),
    },
  };
}

function resultReason(
  reason: Extract<GameSnapshot['match'], { status: 'finished' }>['result']['reason'],
  locale: Locale,
): GameResultViewProps['reason'] {
  switch (reason) {
    case 'scoresCompleted':
      return { kind: 'normal' };
    case 'explicitForfeit':
      return { kind: 'forfeit', text: translate(locale, 'game.resultForfeit') };
    case 'timeoutLimit':
      return { kind: 'timeout', text: translate(locale, 'game.resultTimeout') };
    case 'connectionEnded':
      return { kind: 'connection-ended', text: translate(locale, 'game.resultConnectionEnded') };
  }
}
