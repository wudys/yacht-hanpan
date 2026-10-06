import type { ServerClock } from '@repo/game-client-sdk';
import {
  type CategoryId,
  type DieSlot,
  findSpecialCombinations,
  SPECIAL_COMBINATION,
} from '@repo/yacht-rules';
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { useDelayedRollSpinner } from '@/features/game/game-display-hooks';
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
import { isTurnReady, useDeadlineReadiness } from '@/features/game/hud/game-deadline-hooks';
import { GameDeadlineDisplay } from '@/features/game/hud/GameDeadlineDisplay';
import { GamePresenceNotice, GamePresenceProvider } from '@/features/game/hud/GamePresenceNotice';
import { SettledDiceControls } from '@/features/game/SettledDiceControls';
import { useGameCommands } from '@/features/game/use-game-commands';
import { useGameResultLifecycle } from '@/features/game/use-game-result-lifecycle';
import { useScoreGroupSelection } from '@/features/game/use-score-group-selection';
import { useTurnFeedback } from '@/features/game/use-turn-feedback';
import {
  BonusInfoPopover,
  deriveGameViewModel,
  GameBoard,
  GameResultView,
  ScoreTable,
} from '@/features/game/view';
import { AchievementSequence } from '@/features/game/view/AchievementSequence';
import { GameRollSpinner } from '@/features/game/view/board/GameRollSpinner';
import { SettingsLayer } from '@/features/settings/SettingsLayer';
import { type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import type { GameAudioFeedback } from '@/runtime/audio/game-audio-feedback';
import { PRODUCT_CUE } from '@/runtime/audio/product-cues';
import type { DicePresentation } from '@/runtime/dice/dice-presentation';
import { gamePhysicsAreaBounds } from '@/runtime/dice/game-dice-layout';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';
import type { GameSessionHolder } from '@/runtime/session/game-session-holder';
import type { SessionCredentialStore } from '@/runtime/session/session-credential-store';
import type { SessionRecovery } from '@/runtime/session/session-recovery';
import { useScreenTelemetry } from '@/runtime/telemetry/TelemetryContext';
import { Button } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

type GameScreenProps = Readonly<{
  audio: BrowserAudioRuntime;
  feedback: Pick<GameAudioFeedback, 'observeCommand'>;
  locale: Locale;
  clock: Pick<ServerClock, 'now'>;
  sessions: GameSessionHolder;
  recovery: SessionRecovery;
  sessionCredentialStore: SessionCredentialStore;
  preferences: PreferencesStore;
  presentation: DicePresentation;
}>;

const MemoSettledDiceControls = memo(SettledDiceControls);

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
  sessionCredentialStore,
  preferences,
  presentation,
}: GameScreenProps) {
  const { persistence } = useSyncExternalStore(
    sessionCredentialStore.subscribe,
    sessionCredentialStore.getSnapshot,
  );
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
  const viewerSeatIndex = holderSnapshot.authority?.seatIndex;
  const model = useMemo(
    () =>
      game !== null && viewerSeatIndex !== undefined
        ? deriveGameViewModel(game, viewerSeatIndex)
        : null,
    [game, viewerSeatIndex],
  );
  const scorePresentation = useMemo(
    () => (model === null ? null : createGameScorePresentation(holderSnapshot.room, model, locale)),
    [holderSnapshot.room, model, locale],
  );
  const opponentSeatPresence =
    holderSnapshot.authority === null || presence === null || presence.seats.length !== 2
      ? null
      : presence.seats[holderSnapshot.authority.seatIndex === 0 ? 1 : 0];
  const finished = game?.match.status === 'finished';
  const deadlineAt = game?.match.status === 'playing' ? game.match.currentTurn.deadlineAt : null;
  const startedAt = game?.match.status === 'playing' ? game.match.currentTurn.startedAt : null;
  const {
    ready: deadlineReady,
    turnReady,
    recheck: recheckDeadline,
  } = useDeadlineReadiness(clock, deadlineAt, startedAt);
  const rollPending = pendingCommandKind === 'roll';
  const rollSpinnerVisible = useDelayedRollSpinner(rollPending, holderSnapshot.session);
  const rollProgress = rollSpinnerVisible ? <GameRollSpinner /> : undefined;
  const viewerTurnIdentity =
    holderSnapshot.authority !== null &&
    game?.match.status === 'playing' &&
    game.match.currentTurn.seatIndex === holderSnapshot.authority.seatIndex
      ? `${holderSnapshot.authority.roomId}:${game.match.currentTurn.turnId}`
      : null;

  const returnToLobby = useGameResultLifecycle(
    sessions,
    sessionCredentialStore,
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
  const { phase } = presentationSnapshot;
  const hasPendingCommand = pendingCommandKind !== null;
  const connected = holderSnapshot.sessionSnapshot?.connection === 'connected';
  const recoveryActive = recoverySnapshot.status !== 'idle';
  const hasCommandNotice = rateLimited || commandRetryError !== null;
  const onRecordStart = useCallback(() => {
    if (preferences.getSnapshot().sfxEnabled) audio.playCue(PRODUCT_CUE.SCORE);
  }, [audio, preferences]);
  const turnFeedback = useTurnFeedback(
    {
      session: holderSnapshot.session,
      game,
      presentation: holderSnapshot.sessionSnapshot?.presentation ?? null,
      viewerSeat: viewerSeatIndex ?? null,
      suspended: recoveryActive || (!connected && !finished),
      scoreVisible: (layer === 'board' || layer === 'bonus') && !hasCommandNotice,
      boardVisible: layer === 'board' && !hasCommandNotice && !recordedCategoryNoticeOpen,
      canStartTurn:
        connected &&
        !hasPendingCommand &&
        !hasCommandNotice &&
        !recordedCategoryNoticeOpen &&
        (phase === 'hidden' || phase === 'settled'),
      rollPending,
    },
    clock,
    onRecordStart,
  );
  const { activeGroup, selectGroup, selectYachtGroup } = useScoreGroupSelection(turnFeedback);
  const { record } = turnFeedback;
  const recordFeedbackActive = record !== null;
  const resultVisible = finished && !record?.final;
  useScreenTelemetry(game ? (resultVisible ? 'result' : 'game') : null);
  useEffect(() => {
    void audio.setScene(resultVisible ? 'result' : 'game');
  }, [audio, resultVisible]);

  const summaryIsViewer =
    record !== null && (record.final || record.phase !== 'incoming')
      ? record.record.seatIndex === viewerSeatIndex
      : (model?.turn?.isViewerTurn ?? true);
  const summaryScore = summaryIsViewer ? scorePresentation?.viewer : scorePresentation?.opponent;
  const summaryPlayer = useMemo(
    () => ({
      imageUrl: summaryScore?.imageUrl,
      imageAlt: translate(locale, summaryIsViewer ? 'game.you' : 'game.opponent'),
      label: translate(locale, summaryIsViewer ? 'game.you' : 'game.opponent'),
    }),
    [locale, summaryIsViewer, summaryScore?.imageUrl],
  );
  const inputScopes = useMemo(
    () =>
      deriveGameInputScopes({
        phase,
        hasPendingCommand,
        connected,
        deadlineReady,
        turnReady,
        recordFeedbackActive,
        layer,
        recoveryActive,
        hasCommandNotice,
        recordedCategoryNoticeOpen,
      }),
    [
      phase,
      hasPendingCommand,
      connected,
      deadlineReady,
      turnReady,
      recordFeedbackActive,
      layer,
      recoveryActive,
      hasCommandNotice,
      recordedCategoryNoticeOpen,
    ],
  );
  const interaction = useMemo(
    () => (model === null ? null : deriveGameInteraction(model, inputScopes)),
    [model, inputScopes],
  );
  const boardModel = interaction?.boardModel;
  const boardPresentation = useMemo(
    () => (boardModel === undefined ? null : createGameBoardPresentation(boardModel, locale)),
    [boardModel, locale],
  );
  const turn = model?.turn;
  const currentTurn = game?.match.status === 'playing' ? game.match.currentTurn : null;
  const currentDice = currentTurn?.dice;
  const yachtAvailable =
    !rollPending &&
    currentTurn !== null &&
    currentDice !== null &&
    currentDice !== undefined &&
    (phase === 'achievement' || phase === 'settled') &&
    game?.match.players[currentTurn.seatIndex].scorecard.yacht === undefined &&
    findSpecialCombinations([
      currentDice[0].value,
      currentDice[1].value,
      currentDice[2].value,
      currentDice[3].value,
      currentDice[4].value,
    ]).includes(SPECIAL_COMBINATION.YACHT);
  const acceptedPresentation = holderSnapshot.sessionSnapshot?.presentation;
  const yachtRollId =
    yachtAvailable && acceptedPresentation?.kind === 'roll'
      ? acceptedPresentation.roll.replay.rollId
      : null;
  const consumedYacht = useRef<Readonly<{ session: object | null; rollId: string }> | null>(null);
  useLayoutEffect(() => {
    if (yachtRollId === null) return;
    if (
      consumedYacht.current?.session === holderSnapshot.session &&
      consumedYacht.current.rollId === yachtRollId
    )
      return;
    consumedYacht.current = { session: holderSnapshot.session, rollId: yachtRollId };
    if (!recoveryActive && document.visibilityState !== 'hidden') selectYachtGroup();
  }, [holderSnapshot.session, recoveryActive, selectYachtGroup, yachtRollId]);
  const canHold = interaction?.canHold ?? false;
  const canScore = interaction?.canScore ?? false;
  const canExplainRecordedCategory = interaction?.canExplainRecordedCategory ?? false;
  const setDieHeld = useCallback(
    (slot: DieSlot, isHeld: boolean) => {
      if (canHold && isTurnReady(clock, deadlineAt, startedAt) && turn?.dice[slot]?.held !== isHeld)
        submitDieHeld(slot, isHeld);
    },
    [canHold, clock, deadlineAt, startedAt, turn?.dice, submitDieHeld],
  );
  const onSelectScore = useCallback(
    (categoryId: CategoryId) => {
      if (canScore && isTurnReady(clock, deadlineAt, startedAt)) selectScore(categoryId);
    },
    [canScore, clock, deadlineAt, startedAt, selectScore],
  );
  const onBlockedScore = useCallback(() => {
    if (canExplainRecordedCategory && viewerTurnIdentity !== null) {
      setRecordedCategoryNoticeTurnIdentity(viewerTurnIdentity);
    }
  }, [canExplainRecordedCategory, viewerTurnIdentity]);
  const onScoreGroupChange = useCallback(
    (group: 'upper' | 'lower') => {
      if (inputScopes.canNavigateBoardLayers) {
        selectGroup(group);
        if (group !== activeGroup) audio.playCue(PRODUCT_CUE.SELECT);
      }
    },
    [activeGroup, audio, inputScopes.canNavigateBoardLayers, selectGroup],
  );
  const onOpenScoreboard = useCallback(() => {
    if (inputScopes.canNavigateBoardLayers) {
      audio.playCue(PRODUCT_CUE.CLICK);
      setLayer('scoreboard');
    }
  }, [audio, inputScopes.canNavigateBoardLayers]);
  const onOpenBonus = useCallback(() => {
    if (inputScopes.canToggleBonus) {
      audio.playCue(PRODUCT_CUE.CLICK);
      setLayer(layer === 'bonus' ? 'board' : 'bonus');
    }
  }, [audio, inputScopes.canToggleBonus, layer]);

  const click = () => audio.playCue(PRODUCT_CUE.CLICK);
  const closeLayer = () => {
    if (inputScopes.recoveryBlocked) return;
    click();
    setLayer('board');
  };

  const withRecovery = (content: ReactNode): ReactNode => (
    <GamePresenceProvider
      identity={holderSnapshot.session}
      status={opponentSeatPresence?.status ?? null}
      reconnectDeadlineAt={
        opponentSeatPresence?.status === 'disconnected'
          ? opponentSeatPresence.reconnectDeadlineAt
          : null
      }
      persistence={persistence}
      locale={locale}
    >
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
    </GamePresenceProvider>
  );

  if (
    holderSnapshot.authority === null ||
    holderSnapshot.session === null ||
    game === null ||
    presence === null ||
    presence.seats.length !== 2 ||
    model === null ||
    scorePresentation === null ||
    summaryScore === undefined ||
    interaction === null ||
    boardModel === undefined ||
    boardPresentation === null
  ) {
    return withRecovery(
      <main data-screen='game' data-game-view='board' aria-busy='true'>
        <h1>{translate(locale, 'game.title')}</h1>
        <p role='status'>{translate(locale, 'game.view.board')}</p>
      </main>,
    );
  }

  const { authority } = holderSnapshot;
  const { viewer, opponent, categories, scoreLabels } = scorePresentation;

  if (game.match.status === 'finished' && resultVisible) {
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
          recordFeedback={
            record?.visible
              ? {
                  identity: String(record.record.stateVersion),
                  categoryId: record.record.categoryId,
                  score: record.record.score,
                  phase: record.phase,
                  startedAt: record.startedAt,
                  bonusEarned: record.bonusEarned,
                }
              : null
          }
          yachtAvailable={yachtAvailable && !recordFeedbackActive}
          turnCue={
            turnFeedback.turnCue === null
              ? null
              : {
                  identity: turnFeedback.turnCue.turnId,
                  startedAt: turnFeedback.turnCue.startedAt,
                }
          }
          turnCueLabel={translate(locale, 'game.turnStartCue')}
          scoreDisplay={{
            owner: summaryIsViewer ? 'viewer' : 'opponent',
            rows: boardModel.scoreRows,
            previewVisible:
              inputScopes.previewVisible &&
              Boolean(boardModel.turn && boardModel.turn.dice.length > 0),
            showFirstRollGuide:
              !recordFeedbackActive && (boardModel.turn?.showFirstRollGuide ?? false),
          }}
          rollAction={boardPresentation.rollAction}
          summaryPlayer={summaryPlayer}
          bonusEarned={summaryScore.upperBonus > 0}
          categories={categories}
          activeGroup={activeGroup}
          timerContent={
            <GameDeadlineDisplay
              clock={clock}
              deadlineAt={deadlineAt}
              startedAt={startedAt}
              locale={locale}
              onReadinessSample={recheckDeadline}
            />
          }
          presenceContent={<GamePresenceNotice />}
          labels={{
            ...boardPresentation.labels,
            timer: '',
            total: `${translate(locale, 'game.total')} ${summaryScore.total}`,
            bonus: translate(locale, 'game.bonus'),
            bonusStatus: translate(
              locale,
              summaryScore.upperBonus > 0 ? 'game.bonusEarned' : 'game.bonusNotEarned',
            ),
          }}
          diceStage={
            <MemoSettledDiceControls
              dice={turn?.dice ?? []}
              label={boardPresentation.labels.diceStage}
              canHold={model.actions.canHold}
              interactionLocked={inputScopes.boardInteractionLocked}
              onSetDieHeld={setDieHeld}
            />
          }
          interactionLocked={inputScopes.boardInteractionLocked}
          rollPending={rollPending}
          rollProgress={rollProgress}
          onRoll={() => {
            if (interaction.canRoll && isTurnReady(clock, deadlineAt, startedAt)) roll();
          }}
          onSetDieHeld={setDieHeld}
          onSelectScore={onSelectScore}
          onBlockedScore={onBlockedScore}
          onScoreGroupChange={onScoreGroupChange}
          onOpenScoreboard={onOpenScoreboard}
          onOpenBonus={onOpenBonus}
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
