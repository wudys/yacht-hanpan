import type { ServerClock } from '@repo/game-client-sdk';
import type { CategoryId, DieSlot } from '@repo/yacht-rules';
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

import { useScoreGroupSelection } from '@/features/game/feedback/use-score-group-selection';
import { useTurnFeedback } from '@/features/game/feedback/use-turn-feedback';
import {
  createGameBoardPresentation,
  createGameScorePresentation,
  createResultPresentation,
  isUnrecordedYachtAvailable,
} from '@/features/game/game-presentation';
import { GameRecoveryFrame } from '@/features/game/GameRecoveryFrame';
import {
  GameBonusPopover,
  GameOverlayLayers,
  GameScoreboardContent,
} from '@/features/game/GameScreenLayers';
import { isTurnReady, useDeadlineReadiness } from '@/features/game/hud/game-deadline-hooks';
import { GameDeadlineDisplay } from '@/features/game/hud/GameDeadlineDisplay';
import { GameStatusNotice, GameStatusNoticeProvider } from '@/features/game/hud/GameStatusNotice';
import {
  deriveGameInputReadiness,
  deriveGameInputScopes,
  deriveGameInteraction,
  deriveGameRecoveryPresentation,
  type GameLayer,
} from '@/features/game/interaction/game-interaction';
import { useGameCommands } from '@/features/game/interaction/use-game-commands';
import { SettledDiceControls } from '@/features/game/SettledDiceControls';
import { deriveGameViewModel, GameBoard, GameResultView } from '@/features/game/ui';
import { GameRollSpinner } from '@/features/game/ui/board/GameBoardStatus';
import { useGameResultLifecycle } from '@/features/game/use-game-result-lifecycle';
import { type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { AUDIO_CUE } from '@/runtime/audio/cue-runtime';
import type { SessionAudioFeedback } from '@/runtime/audio/session-audio-feedback';
import type { DicePresentationController } from '@/runtime/dice/dice-presentation-controller';
import { gamePhysicsAreaBounds } from '@/runtime/dice/game-dice-layout';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';
import type { GameSessionHolder } from '@/runtime/session/game-session-holder';
import type { SessionCredentialStore } from '@/runtime/session/session-credential-store';
import type { SessionRecovery } from '@/runtime/session/session-recovery';
import { useScreenTelemetry } from '@/runtime/telemetry/TelemetryContext';

type GameScreenProps = Readonly<{
  audio: BrowserAudioRuntime;
  feedback: Pick<SessionAudioFeedback, 'observeHoldReceipt'>;
  locale: Locale;
  clock: Pick<ServerClock, 'now'>;
  sessions: GameSessionHolder;
  recovery: SessionRecovery;
  sessionCredentialStore: SessionCredentialStore;
  preferences: PreferencesStore;
  presentation: Pick<DicePresentationController, 'getSnapshot' | 'subscribe'>;
  surfaceExposed: boolean;
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
  surfaceExposed,
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
  const [suppressedAchievementRollId, setSuppressedAchievementRollId] = useState<string | null>(
    null,
  );
  // Consume a covered achievement before this render can expose its title again.
  if (
    (!surfaceExposed || layer === 'scoreboard') &&
    presentationSnapshot.phase === 'achievement' &&
    presentationSnapshot.rollId !== suppressedAchievementRollId
  ) {
    setSuppressedAchievementRollId(presentationSnapshot.rollId);
  }
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
  const rollProgress = rollPending ? <GameRollSpinner /> : undefined;
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
    () => audio.playCue(AUDIO_CUE.CLICK),
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
  const recoveryPresentation = useMemo(
    () =>
      deriveGameRecoveryPresentation({
        snapshot: recoverySnapshot,
        rateLimited,
        commandRetryError,
      }),
    [recoverySnapshot, rateLimited, commandRetryError],
  );
  const { recoveryActive, hasCommandNotice, recoveryBlocked } = recoveryPresentation;
  const readiness = useMemo(
    () =>
      deriveGameInputReadiness({
        phase,
        connected,
        hasPendingCommand,
        recoveryBlocked,
      }),
    [phase, connected, hasPendingCommand, recoveryBlocked],
  );
  const onRecordStart = useCallback(() => {
    if (preferences.getSnapshot().sfxEnabled) audio.playCue(AUDIO_CUE.SCORE);
  }, [audio, preferences]);
  const turnFeedback = useTurnFeedback(
    {
      session: holderSnapshot.session,
      game,
      presentation: holderSnapshot.sessionSnapshot?.presentation ?? null,
      viewerSeat: viewerSeatIndex ?? null,
      suspended: recoveryActive || (!connected && !finished),
      surfaceExposed,
      localScoreVisible: (layer === 'board' || layer === 'bonus') && !hasCommandNotice,
      localBoardVisible: layer === 'board' && !hasCommandNotice && !recordedCategoryNoticeOpen,
      commandPresentationReady: readiness.requestReady && readiness.presentationReady,
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

  const inputScopes = useMemo(
    () =>
      deriveGameInputScopes({
        readiness,
        deadlineReady,
        turnReady,
        recordFeedbackActive,
        layer,
        recordedCategoryNoticeOpen,
      }),
    [readiness, deadlineReady, turnReady, recordFeedbackActive, layer, recordedCategoryNoticeOpen],
  );
  const interaction = useMemo(
    () => (model === null ? null : deriveGameInteraction(model, inputScopes)),
    [model, inputScopes],
  );
  const boardModel = interaction?.boardModel;
  const { turnCue } = turnFeedback;
  const boardPresentation = useMemo(() => {
    if (boardModel === undefined || scorePresentation === null || viewerSeatIndex === undefined)
      return null;
    return createGameBoardPresentation({
      model: boardModel,
      scores: scorePresentation,
      viewerSeatIndex,
      record,
      turnCue,
      locale,
    });
  }, [boardModel, scorePresentation, viewerSeatIndex, record, turnCue, locale]);
  const turn = model?.turn;
  const yachtAvailable = isUnrecordedYachtAvailable(game, phase, rollPending);
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
    if (surfaceExposed && !recoveryActive && document.visibilityState !== 'hidden')
      selectYachtGroup();
  }, [holderSnapshot.session, recoveryActive, selectYachtGroup, surfaceExposed, yachtRollId]);
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
        if (group !== activeGroup) audio.playCue(AUDIO_CUE.SELECT);
      }
    },
    [activeGroup, audio, inputScopes.canNavigateBoardLayers, selectGroup],
  );
  const onOpenScoreboard = useCallback(() => {
    if (inputScopes.canNavigateBoardLayers) {
      audio.playCue(AUDIO_CUE.CLICK);
      setLayer('scoreboard');
    }
  }, [audio, inputScopes.canNavigateBoardLayers]);
  const onOpenBonus = useCallback(() => {
    if (inputScopes.canToggleBonus) {
      audio.playCue(AUDIO_CUE.CLICK);
      setLayer(layer === 'bonus' ? 'board' : 'bonus');
    }
  }, [audio, inputScopes.canToggleBonus, layer]);

  const click = () => audio.playCue(AUDIO_CUE.CLICK);
  const closeLayer = () => {
    if (inputScopes.recoveryBlocked) return;
    click();
    setLayer('board');
  };

  const withRecovery = (content: ReactNode): ReactNode => (
    <GameStatusNoticeProvider
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
        presentation={recoveryPresentation}
        onDismissRateLimit={() => {
          audio.playCue(AUDIO_CUE.CLICK);
          dismissRateLimit();
        }}
        onPermanentFailure={returnToLobby}
        onRefresh={() => globalThis.location.reload()}
        onRetryCommand={retryCommand}
      >
        {content}
      </GameRecoveryFrame>
    </GameStatusNoticeProvider>
  );

  if (
    holderSnapshot.authority === null ||
    holderSnapshot.session === null ||
    game === null ||
    presence === null ||
    presence.seats.length !== 2 ||
    model === null ||
    scorePresentation === null ||
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
  const { viewer, opponent, categories } = scorePresentation;
  const { board, bonusSubtotal } = boardPresentation;

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
        <GameScoreboardContent
          rows={model.scoreRows}
          scores={scorePresentation}
          turnLabel={board.labels.turn}
          locale={locale}
          onClose={closeLayer}
        />
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
          {...board}
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
              <GameBonusPopover subtotal={bonusSubtotal} locale={locale} onClose={closeLayer} />
            ) : null
          }
          yachtAvailable={yachtAvailable && !recordFeedbackActive}
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
          presenceContent={<GameStatusNotice />}
          diceStage={
            <MemoSettledDiceControls
              dice={turn?.dice ?? []}
              label={board.labels.diceStage}
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
      <GameOverlayLayers
        layer={layer}
        locale={locale}
        audio={audio}
        preferences={preferences}
        commandBlocked={inputScopes.commandBlocked}
        recordedCategoryNoticeOpen={recordedCategoryNoticeOpen}
        achievement={
          surfaceExposed &&
          presentationSnapshot.phase === 'achievement' &&
          presentationSnapshot.rollId !== suppressedAchievementRollId
            ? {
                kind: presentationSnapshot.achievement.kind,
                title: translate(locale, `category.${presentationSnapshot.achievement.categoryId}`),
              }
            : null
        }
        onClose={closeLayer}
        onForfeit={forfeit}
        onDismissRecordedCategory={() => {
          click();
          setRecordedCategoryNoticeTurnIdentity(null);
        }}
      />
    </div>,
  );
}
