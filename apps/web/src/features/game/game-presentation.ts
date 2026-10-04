import { requireGameAsset, resolveCharacterImageAssetId } from '@repo/game-assets';
import type { GameSnapshot, PublicRoom } from '@repo/game-protocol/socket';
import { MAX_ROLLS_PER_TURN, type SeatIndex } from '@repo/yacht-rules';

import type {
  CategoryLabels,
  GameBoardProps,
  GameResultViewProps,
  GameViewModel,
  PlayerScoreSummaryView,
} from '@/features/game/view';
import { type Locale, translate } from '@/i18n';

export function createGameScorePresentation(
  room: PublicRoom | null,
  model: Pick<GameViewModel, 'viewer' | 'opponent' | 'scoreRows'>,
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
    categories: Object.fromEntries(
      model.scoreRows.map(({ categoryId }) => [
        categoryId,
        translate(locale, `category.${categoryId}`),
      ]),
    ) as CategoryLabels,
    scoreLabels: {
      categoryHeader: translate(locale, 'game.category'),
      upperSubtotal: translate(locale, 'game.upper'),
      bonus: translate(locale, 'game.bonus'),
    },
  };
}

export function createGameBoardPresentation(
  model: Pick<GameViewModel, 'turn' | 'scoreGroupPreviews'>,
  locale: Locale,
) {
  const { turn, scoreGroupPreviews } = model;
  const readOnly = turn !== null && (!turn.isViewerTurn || turn.rollCount === MAX_ROLLS_PER_TURN);
  const rollLabel = !turn?.isViewerTurn
    ? 'game.opponentTurn'
    : turn.rollCount === 0
      ? 'game.roll'
      : readOnly
        ? 'game.rollComplete'
        : 'game.reroll';
  const highest = (value: number | null): string | null =>
    value === null ? null : `${translate(locale, 'game.highest')} ${value}`;
  return {
    rollAction: { label: translate(locale, rollLabel), readOnly },
    labels: {
      turn: `${translate(locale, 'game.turn')} ${turn?.ordinal ?? '—'}/${turn?.total ?? '—'}`,
      settings: translate(locale, 'game.settings'),
      diceStage: translate(locale, 'game.diceStage'),
      heldDice: translate(locale, 'game.diceControls'),
      rollsRemaining: translate(locale, 'game.rollsRemaining', {
        count: MAX_ROLLS_PER_TURN - (turn?.rollCount ?? 0),
      }),
      turnState: translate(locale, turn?.isViewerTurn ? 'game.myTurn' : 'game.opponentTurn'),
      bonusInfo: translate(locale, 'game.bonusInfo'),
      scoreboard: translate(locale, 'game.view.scoreboard'),
      upper: translate(locale, 'game.upper'),
      lower: translate(locale, 'game.lower'),
      highestUpper: highest(scoreGroupPreviews.upper),
      highestLower: highest(scoreGroupPreviews.lower),
      firstRollGuide: translate(locale, 'game.firstRollGuide'),
      emptyScore: translate(locale, 'game.emptyScore'),
    } satisfies Omit<
      GameBoardProps['labels'],
      'timer' | 'total' | 'bonus' | 'bonusStatus' | 'presence'
    >,
  };
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
  const reason: GameResultViewProps['reason'] =
    result.reason === 'scoresCompleted'
      ? { kind: 'normal' }
      : result.reason === 'explicitForfeit'
        ? { kind: 'forfeit', text: translate(locale, 'game.resultForfeit') }
        : result.reason === 'timeoutLimit'
          ? { kind: 'timeout', text: translate(locale, 'game.resultTimeout') }
          : { kind: 'connection-ended', text: translate(locale, 'game.resultConnectionEnded') };
  return {
    outcome,
    reason,
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
