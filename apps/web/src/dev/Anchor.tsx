import { requireGameAsset, resolveCharacterImageAssetId } from '@repo/game-assets';
import { MAX_ROLLS_PER_TURN } from '@repo/yacht-rules';
import { type CSSProperties, type ReactNode, useState } from 'react';

import { createAnchorGame, createAnchorResult } from '@/dev/anchor-models';
import { createGameBoardPresentation } from '@/features/game/game-presentation';
import { type CategoryLabels, GameBoard, GameResultView, ScoreTable } from '@/features/game/view';
import { AchievementSequence } from '@/features/game/view/AchievementSequence';
import { LobbyView } from '@/features/lobby/view/LobbyView';
import { type Locale, type MessageKey, type MessageKeyWithoutParams, translate } from '@/i18n';
import { Button } from '@/ui/button';
import { GameFrame } from '@/ui/layout';
import { ScrollablePanel } from '@/ui/panel';

const RESULT_REASON_MESSAGE = {
  forfeit: 'game.resultForfeit',
  timeout: 'game.resultTimeout',
  'connection-ended': 'game.resultConnectionEnded',
} as const satisfies Readonly<
  Record<Exclude<ReturnType<typeof createAnchorResult>['reason'], 'normal'>, MessageKey>
>;

export type AnchorProps = Readonly<{
  anchor: string;
  mode: string;
  locale: Locale;
  replay?: ReactNode;
}>;

export function Anchor({ anchor, mode, locale, replay }: AnchorProps) {
  const t = (key: MessageKeyWithoutParams) => translate(locale, key);
  const result = createAnchorResult(mode);
  const model = anchor === 'result' ? result.model : createAnchorGame(mode);
  const categories = Object.fromEntries(
    model.scoreRows.map(({ categoryId }) => [categoryId, t(`category.${categoryId}`)]),
  ) as CategoryLabels;
  const viewerImage = requireGameAsset(resolveCharacterImageAssetId('navy-bob', false)).url;
  const opponentImage = requireGameAsset(resolveCharacterImageAssetId('blonde-buns', false)).url;
  const viewer = {
    label: t('game.you'),
    imageUrl: viewerImage,
    imageAlt: t('game.you'),
    selfLabel: t('game.you'),
    total: model.viewer.total,
    upperSubtotal: model.viewer.upperSubtotal,
    upperBonus: model.viewer.upperBonus,
  };
  const opponent = {
    label: t('game.opponent'),
    imageUrl: opponentImage,
    imageAlt: t('game.opponent'),
    total: model.opponent.total,
    upperSubtotal: model.opponent.upperSubtotal,
    upperBonus: model.opponent.upperBonus,
  };

  const [group, setGroup] = useState<'upper' | 'lower'>('lower');
  const [lastIntent, setLastIntent] = useState('none');
  const record = (intent: string) => () => setLastIntent(intent);
  const { turn } = model;
  const summaryPlayer = turn?.isViewerTurn ? viewer : opponent;
  const boardPresentation = createGameBoardPresentation(model, locale);
  const stageFaces: readonly (keyof typeof categories)[] =
    mode === 'before-roll'
      ? []
      : anchor === 'achievement'
        ? Array.from({ length: 3 }, () => (mode === 'yacht' ? 'fives' : 'fours'))
        : ['fours', 'twos', 'threes'];
  const gameBoard = (
    <GameBoard
      rolling={replay !== undefined}
      rollRailHidden={replay !== undefined}
      model={model}
      rollAction={boardPresentation.rollAction}
      summaryPlayer={summaryPlayer}
      bonusEarned={summaryPlayer.upperBonus > 0}
      categories={categories}
      activeGroup={group}
      labels={{
        turn: `${t('game.turn')} ${turn?.ordinal}/12`,
        timer: `60${t('game.seconds')}`,
        settings: t('game.settings'),
        diceStage: t('game.diceStage'),
        heldDice: t('game.diceControls'),
        rollsRemaining: translate(locale, 'game.rollsRemaining', {
          count: MAX_ROLLS_PER_TURN - (turn?.rollCount ?? 0),
        }),
        turnState: t(turn?.isViewerTurn ? 'game.myTurn' : 'game.opponentTurn'),
        total: `${t('game.total')} ${summaryPlayer.total}`,
        bonus: t('game.bonus'),
        bonusStatus: t(summaryPlayer.upperBonus > 0 ? 'game.bonusEarned' : 'game.bonusNotEarned'),
        bonusInfo: t('game.bonusInfo'),
        scoreboard: t('game.view.scoreboard'),
        upper: t('game.upper'),
        lower: t('game.lower'),
        highestUpper: boardPresentation.labels.highestUpper,
        highestLower: boardPresentation.labels.highestLower,
        firstRollGuide: t('game.firstRollGuide'),
        emptyScore: t('game.emptyScore'),
      }}
      diceStage={
        replay !== undefined ? null : (
          <div
            className='anchor-stage-dice'
            aria-label='Static layout fixture — not physical replay'
          >
            {stageFaces.map((face, index) => (
              <img
                key={`${face}-${index}`}
                src={requireGameAsset(`score.${face}`).url}
                alt=''
                data-anchor-stage-face={face}
              />
            ))}
          </div>
        )
      }
      interactionLocked={mode === 'pending' || anchor === 'achievement'}
      onRoll={record('roll')}
      onSetDieHeld={(slot) => setLastIntent(`hold:${slot}`)}
      onSelectScore={(category) => setLastIntent(`score:${category}`)}
      onScoreGroupChange={setGroup}
      onOpenScoreboard={record('scoreboard')}
      onOpenBonus={record('bonus')}
      onOpenSettings={record('settings')}
    />
  );
  let view;
  if (anchor === 'lobby') {
    view = (
      <LobbyView
        profile={{ imageUrl: viewerImage, alt: t('game.you') }}
        labels={{
          editProfile: t('lobby.profile'),
          settings: t('lobby.settings'),
          createRoom: t('lobby.createRoom'),
          joinRoom: t('lobby.joinRoom'),
        }}
        onEditProfile={record('profile')}
        onOpenSettings={record('settings')}
        onCreateRoom={record('create')}
        onJoinRoom={record('join')}
      />
    );
  } else if (anchor === 'scoreboard') {
    view = (
      <div className='score-layer-frame'>
        <ScrollablePanel
          title={t('game.view.scoreboard')}
          meta={`${t('game.turn')} ${turn?.ordinal}/12`}
          footer={<Button label={t('common.close')} onClick={record('close')} />}
        >
          <ScoreTable
            rows={model.scoreRows}
            categories={categories}
            viewer={viewer}
            opponent={opponent}
            labels={{
              categoryHeader: t('game.category'),
              upperSubtotal: t('game.upper'),
              bonus: t('game.bonus'),
            }}
          />
        </ScrollablePanel>
      </div>
    );
  } else if (anchor === 'result') {
    view = (
      <GameResultView
        rows={model.scoreRows}
        viewer={viewer}
        opponent={opponent}
        categories={categories}
        outcome={result.outcome}
        reason={
          result.reason === 'normal'
            ? { kind: 'normal' }
            : { kind: result.reason, text: t(RESULT_REASON_MESSAGE[result.reason]) }
        }
        labels={{
          title: t('game.view.result'),
          categoryHeader: t('game.category'),
          upperSubtotal: t('game.upper'),
          bonus: t('game.bonus'),
          win: t('game.win'),
          loss: t('game.loss'),
          draw: t('game.draw'),
          backToLobby: t('game.backToLobby'),
        }}
        onBackToLobby={record('lobby')}
      />
    );
  } else if (anchor === 'achievement') {
    const kind = mode === 'yacht' ? 'yacht' : 'other';
    view = (
      <div className='web-game-bonus-host'>
        {gameBoard}
        <div className='web-game-achievement-overlay' data-game-achievement-layer='true'>
          <AchievementSequence
            kind={kind}
            title={t(kind === 'yacht' ? 'category.yacht' : 'category.full-house')}
          />
        </div>
      </div>
    );
  } else {
    view = gameBoard;
  }
  return (
    <div
      className='web-app-shell'
      data-anchor={anchor}
      data-last-intent={lastIntent}
      style={
        {
          '--web-wrapper-pattern-image': `url("${requireGameAsset('brand.wrapper-pattern').url}")`,
        } as CSSProperties
      }
    >
      <GameFrame orientationMessage={t('game.portraitRequired')}>
        {view}
        {replay}
      </GameFrame>
      <p className='anchor-fixture-label'>
        DEV-01 · {anchor} · {locale} · layout fixture
      </p>
    </div>
  );
}
