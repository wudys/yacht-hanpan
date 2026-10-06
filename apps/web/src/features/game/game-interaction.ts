import type { GameViewModel } from '@/features/game/view/game-view-model';
import type { DicePresentationSnapshot } from '@/runtime/dice/dice-presentation';

export type GameLayer = 'board' | 'bonus' | 'scoreboard' | 'settings';

export function deriveGameInputReadiness({
  phase,
  hasPendingCommand,
  connected,
  recoveryActive,
  hasCommandNotice,
}: Readonly<{
  phase: DicePresentationSnapshot['phase'];
  hasPendingCommand: boolean;
  connected: boolean;
  recoveryActive: boolean;
  hasCommandNotice: boolean;
}>) {
  const recoveryBlocked = recoveryActive || hasCommandNotice;
  return {
    recoveryBlocked,
    requestReady: connected && !hasPendingCommand && !recoveryBlocked,
    presentationReady: phase === 'hidden' || phase === 'settled',
    previewRevealed: phase === 'settled',
  };
}

export function deriveGameInputScopes({
  readiness,
  deadlineReady,
  turnReady,
  recordFeedbackActive,
  layer,
  recordedCategoryNoticeOpen,
}: Readonly<{
  readiness: ReturnType<typeof deriveGameInputReadiness>;
  deadlineReady: boolean;
  turnReady: boolean;
  recordFeedbackActive: boolean;
  layer: GameLayer;
  recordedCategoryNoticeOpen: boolean;
}>) {
  const { recoveryBlocked, requestReady, presentationReady, previewRevealed } = readiness;
  const commandBlocked = !requestReady || !deadlineReady;
  const gameplayCommandBlocked =
    commandBlocked || !presentationReady || !turnReady || recordFeedbackActive;
  return {
    commandBlocked,
    gameplayBlocked: gameplayCommandBlocked || layer !== 'board' || recordedCategoryNoticeOpen,
    boardInert: layer === 'settings' || recordedCategoryNoticeOpen,
    recoveryBlocked,
    previewVisible: previewRevealed && !recordFeedbackActive,
    boardInteractionLocked: gameplayCommandBlocked || layer === 'bonus',
    canNavigateBoardLayers: !recoveryBlocked && !recordedCategoryNoticeOpen && layer === 'board',
    canToggleBonus:
      !recoveryBlocked && !recordedCategoryNoticeOpen && (layer === 'board' || layer === 'bonus'),
  };
}

/** Keeps category and group previews on the same disclosure boundary. */
export function applyScorePreviewVisibility(model: GameViewModel, visible: boolean): GameViewModel {
  return visible
    ? model
    : {
        ...model,
        scoreRows: model.scoreRows.map((row) => ({
          ...row,
          previewScore: null,
          selectable: false,
        })),
        scoreGroupPreviews: { upper: null, lower: null },
      };
}

/** Adds domain eligibility to the scope-specific presentation rules. */
export function deriveGameInteraction(
  model: GameViewModel,
  scopes: ReturnType<typeof deriveGameInputScopes>,
) {
  const boardModel = applyScorePreviewVisibility(model, scopes.previewVisible);
  return {
    boardModel,
    canRoll: !scopes.gameplayBlocked && model.actions.canRoll,
    canHold: !scopes.gameplayBlocked && model.actions.canHold,
    canScore: !scopes.gameplayBlocked && model.actions.canScore,
    canExplainRecordedCategory: !scopes.gameplayBlocked && model.turn?.isViewerTurn === true,
  };
}
