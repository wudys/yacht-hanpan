import type { ServerClock } from '@repo/game-client-sdk';
import type { DieSlot } from '@repo/yacht-rules';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';

import {
  useDeadlineSeconds,
  useDelayedRollProgress,
  useOpponentPresenceNotice,
  useViewerTurnSummaryEmphasis,
} from '@/features/game/game-display-hooks';
import {
  deriveGameInputScopes,
  deriveGameInteraction,
  type GameLayer,
} from '@/features/game/game-interaction';
import {
  createGameBoardPresentation,
  createGameScorePresentation,
  createResultPresentation,
} from '@/features/game/game-presentation';
import { GameRecoveryFrame } from '@/features/game/GameRecoveryFrame';
import { SettledDiceControls } from '@/features/game/SettledDiceControls';
import { useGameCommands } from '@/features/game/use-game-commands';
import { useGameResultLifecycle } from '@/features/game/use-game-result-lifecycle';
import {
  BonusInfoPopover,
  deriveGameViewModel,
  GameBoard,
  GameResultView,
  ScoreTable,
} from '@/features/game/view';
import { AchievementSequence } from '@/features/game/view/AchievementSequence';
import { SettingsLayer } from '@/features/settings/SettingsLayer';
import { type Locale, translate } from '@/i18n';
import type { ProductAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import type { GameAudioFeedback } from '@/runtime/audio/game-audio-feedback';
import { PRODUCT_CUE } from '@/runtime/audio/product-cues';
import type { DicePresentation } from '@/runtime/dice/dice-presentation';
import { gamePhysicsAreaBounds } from '@/runtime/dice/game-dice-layout';
import type { ProductPreferences } from '@/runtime/preferences/product-preferences';
import type { BrowserSessionStore } from '@/runtime/session/browser-session-store';
import type { GameSessionHolder } from '@/runtime/session/session-holder';
import type { SessionRecovery } from '@/runtime/session/session-recovery';
import { useScreenTelemetry } from '@/runtime/telemetry/TelemetryContext';
import { Button } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

type GameScreenProps = Readonly<{
  audio: ProductAudioRuntime;
  feedback: Pick<GameAudioFeedback, 'observeCommand'>;
  locale: Locale;
  clock: Pick<ServerClock, 'now'>;
  sessions: GameSessionHolder;
  recovery: SessionRecovery;
  store: BrowserSessionStore;
  preferences: ProductPreferences;
  presentation: DicePresentation;
}>;

const VISUALLY_HIDDEN_STYLE = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
} as const;

export default function GameScreen({
  audio,
  feedback,
  clock,
  locale,
  recovery,
  sessions,
  store,
  preferences,
  presentation,
}: GameScreenProps) {
  const { persistence } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const presentationSnapshot = useSyncExternalStore(
    presentation.subscribe,
    presentation.getSnapshot,
  );
  const {
    holderSnapshot,
    recoverySnapshot,
    pendingCommandKind,
    rateLimited,
    commandRetryError,
    dismissRateLimit,
    roll,
    setDieHeld: submitDieHeld,
    selectScore,
    forfeit,
    retryCommand,
  } = useGameCommands(sessions, recovery, audio, feedback);
  const [activeGroup, setActiveGroup] = useState<'lower' | 'upper'>('upper');
  const [layer, setLayer] = useState<GameLayer>('board');
  const [skippedAchievementRollId, setSkippedAchievementRollId] = useState<string | null>(null);
  useEffect(() => {
    if (layer === 'scoreboard' && presentationSnapshot.phase === 'achievement') {
      setSkippedAchievementRollId(presentationSnapshot.rollId);
    }
  }, [layer, presentationSnapshot]);
  const [recordedCategoryNoticeTurnIdentity, setRecordedCategoryNoticeTurnIdentity] = useState<
    string | null
  >(null);
  const game = holderSnapshot.sessionSnapshot?.game ?? null;
  const presence = holderSnapshot.sessionSnapshot?.presence ?? null;
  const opponentSeatPresence =
    holderSnapshot.authority === null || presence === null || presence.seats.length !== 2
      ? null
      : presence.seats[holderSnapshot.authority.seatIndex === 0 ? 1 : 0];
  const opponentPresence = useOpponentPresenceNotice(opponentSeatPresence);
  const finished = game?.match.status === 'finished';
  useScreenTelemetry(game ? (finished ? 'result' : 'game') : null);
  const deadlineAt = game?.match.status === 'playing' ? game.match.currentTurn.deadlineAt : null;
  const secondsRemaining = useDeadlineSeconds(clock, deadlineAt);
  const rollProgress = useDelayedRollProgress(pendingCommandKind);
  const viewerTurnIdentity =
    holderSnapshot.authority !== null &&
    game?.match.status === 'playing' &&
    game.match.currentTurn.seatIndex === holderSnapshot.authority.seatIndex
      ? `${holderSnapshot.authority.roomId}:${game.match.currentTurn.turnId}`
      : null;
  const summaryEmphasized = useViewerTurnSummaryEmphasis(viewerTurnIdentity, layer === 'board');
  useEffect(() => {
    void audio.setScene(finished ? 'result' : 'game');
  }, [audio, finished]);

  const returnToLobby = useGameResultLifecycle(
    sessions,
    store,
    holderSnapshot,
    () => audio.playCue(PRODUCT_CUE.CLICK),
    pendingCommandKind !== null,
  );

  useEffect(() => {
    if (recordedCategoryNoticeTurnIdentity !== null && recoverySnapshot.status !== 'idle') {
      setRecordedCategoryNoticeTurnIdentity(null);
    }
  }, [recordedCategoryNoticeTurnIdentity, recoverySnapshot.status]);

  const recordedCategoryNoticeOpen =
    recoverySnapshot.status === 'idle' &&
    viewerTurnIdentity !== null &&
    recordedCategoryNoticeTurnIdentity === viewerTurnIdentity;
  const inputScopes = deriveGameInputScopes({
    phase: presentationSnapshot.phase,
    hasPendingCommand: pendingCommandKind !== null,
    connected: holderSnapshot.sessionSnapshot?.connection === 'connected',
    secondsRemaining,
    layer,
    recoveryActive: recoverySnapshot.status !== 'idle',
    hasCommandNotice: rateLimited || commandRetryError !== null,
    recordedCategoryNoticeOpen,
  });

  const click = () => audio.playCue(PRODUCT_CUE.CLICK);
  const closeLayer = () => {
    if (inputScopes.recoveryBlocked) return;
    click();
    setLayer('board');
  };

  const withRecovery = (content: ReactNode): ReactNode => (
    <GameRecoveryFrame
      locale={locale}
      interactionLocked={inputScopes.recoveryBlocked}
      commandRetryError={commandRetryError}
      rateLimited={rateLimited}
      snapshot={recoverySnapshot}
      onDismissRateLimit={() => {
        audio.playCue(PRODUCT_CUE.CLICK);
        dismissRateLimit();
      }}
      onPermanentFailure={returnToLobby}
      onRefresh={() => globalThis.location.reload()}
      onRetryCommand={retryCommand}
    >
      {content}
    </GameRecoveryFrame>
  );

  if (
    holderSnapshot.authority === null ||
    holderSnapshot.session === null ||
    game === null ||
    presence === null ||
    presence.seats.length !== 2
  ) {
    return withRecovery(
      <main data-screen='game' data-game-view='board' aria-busy='true'>
        <h1>{translate(locale, 'game.title')}</h1>
        <p role='status'>{translate(locale, 'game.view.board')}</p>
      </main>,
    );
  }

  const { authority, room } = holderSnapshot;
  const model = deriveGameViewModel(game, authority.seatIndex);
  const { viewer, opponent, categories, scoreLabels } = createGameScorePresentation(
    room,
    model,
    locale,
  );
  const summaryIsViewer = model.turn?.isViewerTurn ?? true;
  const summaryScore = summaryIsViewer ? viewer : opponent;

  if (game.match.status === 'finished') {
    const resultPresentation = createResultPresentation(
      game.match.result,
      authority.seatIndex,
      locale,
    );

    return withRecovery(
      <div data-screen='game' data-game-view='result'>
        <GameResultView
          rows={model.scoreRows}
          viewer={viewer}
          opponent={opponent}
          categories={categories}
          {...resultPresentation}
          onBackToLobby={returnToLobby}
        />
      </div>,
    );
  }

  const interaction = deriveGameInteraction(model, inputScopes);
  const { boardModel } = interaction;
  const boardPresentation = createGameBoardPresentation(boardModel, locale);
  const { turn } = model;
  if (layer === 'scoreboard') {
    return withRecovery(
      <div
        className='score-layer-frame'
        data-screen='game'
        data-game-view='board'
        data-game-layer='scoreboard'
      >
        <ScrollablePanel
          title={translate(locale, 'game.view.scoreboard')}
          meta={boardPresentation.labels.turn}
          footer={
            <Button
              label={translate(locale, 'common.close')}
              variant='secondary'
              onClick={closeLayer}
            />
          }
        >
          <ScoreTable
            rows={model.scoreRows}
            categories={categories}
            viewer={viewer}
            opponent={opponent}
            labels={scoreLabels}
          />
        </ScrollablePanel>
      </div>,
    );
  }

  const setDieHeld = (slot: DieSlot, isHeld: boolean) => {
    if (interaction.canHold) {
      if (turn?.dice[slot]?.held === isHeld) return;
      submitDieHeld(slot, isHeld);
    }
  };

  return withRecovery(
    <div
      className='web-game-bonus-host'
      data-storage-warning={persistence === 'memoryOnly' || undefined}
      data-screen='game'
      data-game-view='board'
      data-game-layer={layer}
    >
      <h1 style={VISUALLY_HIDDEN_STYLE}>{translate(locale, 'game.title')}</h1>
      <div inert={inputScopes.boardInert} aria-hidden={inputScopes.boardInert}>
        <GameBoard
          rolling={
            presentationSnapshot.phase === 'rolling' || presentationSnapshot.phase === 'revealing'
          }
          rollRailHidden={
            presentationSnapshot.phase !== 'hidden' && presentationSnapshot.phase !== 'settled'
          }
          physicsArea={
            presentationSnapshot.phase === 'rolling' &&
            presentationSnapshot.playback.status === 'verified' ? (
              <div
                className='dice-board__physics-area'
                aria-hidden='true'
                style={gamePhysicsAreaBounds(presentationSnapshot.playback.timeline.rollArea)}
              />
            ) : null
          }
          bonusPopover={
            layer === 'bonus' ? (
              <BonusInfoPopover
                subtotal={summaryScore.upperSubtotal}
                labels={{
                  title: translate(locale, 'game.bonusInfo'),
                  upperRange: translate(locale, 'game.bonusUpperRange'),
                  subtotal: translate(locale, 'game.bonusSubtotal'),
                  close: translate(locale, 'common.close'),
                }}
                onClose={closeLayer}
              />
            ) : null
          }
          model={boardModel}
          rollAction={boardPresentation.rollAction}
          summaryPlayer={{
            imageUrl: summaryScore.imageUrl,
            imageAlt: translate(locale, summaryIsViewer ? 'game.you' : 'game.opponent'),
            selfLabel: summaryIsViewer ? translate(locale, 'game.you') : undefined,
          }}
          bonusEarned={summaryScore.upperBonus > 0}
          categories={categories}
          activeGroup={activeGroup}
          summaryEmphasized={summaryEmphasized}
          timerWarning={secondsRemaining !== null && secondsRemaining <= 5}
          labels={{
            ...boardPresentation.labels,
            timer: `${secondsRemaining ?? '—'}${translate(locale, 'game.seconds')}`,
            total: `${translate(locale, 'game.total')} ${summaryScore.total}`,
            bonus: translate(locale, 'game.bonus'),
            bonusStatus: translate(
              locale,
              summaryScore.upperBonus > 0 ? 'game.bonusEarned' : 'game.bonusNotEarned',
            ),
            presence:
              persistence === 'memoryOnly' && opponentPresence !== 'disconnected'
                ? translate(locale, 'session.storageFailure')
                : opponentPresence === null
                  ? undefined
                  : translate(
                      locale,
                      opponentPresence === 'disconnected'
                        ? 'game.opponentDisconnected'
                        : 'game.opponentReconnected',
                    ),
          }}
          diceStage={
            <SettledDiceControls
              dice={turn?.dice ?? []}
              label={boardPresentation.labels.diceStage}
              canHold={model.actions.canHold}
              interactionLocked={inputScopes.boardInteractionLocked}
              onSetDieHeld={setDieHeld}
            />
          }
          interactionLocked={inputScopes.boardInteractionLocked}
          rollProgress={rollProgress}
          onRoll={() => {
            if (interaction.canRoll) roll();
          }}
          onSetDieHeld={setDieHeld}
          onSelectScore={(categoryId) => {
            if (interaction.canScore) {
              selectScore(categoryId);
            }
          }}
          onBlockedScore={() => {
            if (interaction.canExplainRecordedCategory && viewerTurnIdentity !== null) {
              setRecordedCategoryNoticeTurnIdentity(viewerTurnIdentity);
            }
          }}
          onScoreGroupChange={(group) => {
            if (inputScopes.canNavigateBoardLayers && group !== activeGroup) {
              setActiveGroup(group);
              audio.playCue(PRODUCT_CUE.SELECT);
            }
          }}
          onOpenScoreboard={() => {
            if (inputScopes.canNavigateBoardLayers) {
              click();
              setLayer('scoreboard');
            }
          }}
          onOpenBonus={() => {
            if (inputScopes.canToggleBonus) {
              click();
              setLayer(layer === 'bonus' ? 'board' : 'bonus');
            }
          }}
          onOpenSettings={() => {
            if (inputScopes.canNavigateBoardLayers) {
              click();
              setLayer('settings');
            }
          }}
        />
      </div>
      {layer === 'bonus' ? (
        <div className='web-game-bonus-overlay' data-game-bonus-layer='true'>
          <button
            className='web-game-bonus-dismiss'
            type='button'
            aria-label={translate(locale, 'common.close')}
            data-game-bonus-dismiss='true'
            onClick={closeLayer}
          />
        </div>
      ) : null}
      {layer === 'settings' ? (
        <div className='web-settings-overlay'>
          <SettingsLayer
            audio={audio}
            preferences={preferences}
            onClose={closeLayer}
            forfeit={{
              disabled: inputScopes.commandBlocked,
              onIntent: forfeit,
            }}
          />
        </div>
      ) : null}
      {recordedCategoryNoticeOpen ? (
        <div
          className='web-game-category-notice'
          role='alertdialog'
          aria-modal='true'
          aria-label={translate(locale, 'game.recordedCategoryTitle')}
        >
          <ScrollablePanel
            variant='notice'
            title={translate(locale, 'game.recordedCategoryTitle')}
            footer={
              <Button
                label={translate(locale, 'common.confirm')}
                onClick={() => {
                  click();
                  setRecordedCategoryNoticeTurnIdentity(null);
                }}
              />
            }
          >
            <p>{translate(locale, 'game.recordedCategoryDescription')}</p>
          </ScrollablePanel>
        </div>
      ) : null}
      {presentationSnapshot.phase === 'achievement' &&
      presentationSnapshot.rollId !== skippedAchievementRollId ? (
        <div className='web-game-achievement-overlay' data-game-achievement-layer='true'>
          <AchievementSequence
            kind={presentationSnapshot.achievement.kind}
            title={translate(locale, `category.${presentationSnapshot.achievement.categoryId}`)}
          />
        </div>
      ) : null}
    </div>,
  );
}
