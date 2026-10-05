import type { GameViewModel } from '@/features/game/view/game-view-model';
import type { DicePresentationSnapshot } from '@/runtime/dice/dice-presentation';

export type GameLayer = 'board' | 'bonus' | 'scoreboard' | 'settings';

export function deriveGameInputScopes({
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
}: Readonly<{
  phase: DicePresentationSnapshot['phase'];
  hasPendingCommand: boolean;
  connected: boolean;
  deadlineReady: boolean;
  turnReady: boolean;
  recordFeedbackActive: boolean;
  layer: GameLayer;
  recoveryActive: boolean;
  hasCommandNotice: boolean;
  recordedCategoryNoticeOpen: boolean;
}>) {
  const recoveryBlocked = recoveryActive || hasCommandNotice;
  const presentationBlocked =
    phase === 'resolving' ||
    phase === 'rolling' ||
    phase === 'revealing' ||
    phase === 'achievement';
  const commandBlocked = recoveryBlocked || hasPendingCommand || !connected || !deadlineReady;
  const gameplayCommandBlocked =
    commandBlocked || presentationBlocked || !turnReady || recordFeedbackActive;
  return {
    commandBlocked,
    gameplayBlocked: gameplayCommandBlocked || layer !== 'board' || recordedCategoryNoticeOpen,
    boardInert: layer === 'settings' || recordedCategoryNoticeOpen,
    recoveryBlocked,
    previewVisible: phase === 'settled',
    boardInteractionLocked: gameplayCommandBlocked || layer === 'bonus',
    canNavigateBoardLayers: !recoveryBlocked && !recordedCategoryNoticeOpen && layer === 'board',
    canToggleBonus:
      !recoveryBlocked && !recordedCategoryNoticeOpen && (layer === 'board' || layer === 'bonus'),
  };
}

/** Adds domain eligibility to the scope-specific presentation rules. */
export function deriveGameInteraction(
  model: GameViewModel,
  scopes: ReturnType<typeof deriveGameInputScopes>,
) {
  const boardModel: GameViewModel = scopes.previewVisible
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
  return {
    boardModel,
    canRoll: !scopes.gameplayBlocked && model.actions.canRoll,
    canHold: !scopes.gameplayBlocked && model.actions.canHold,
    canScore: !scopes.gameplayBlocked && model.actions.canScore,
    canExplainRecordedCategory: !scopes.gameplayBlocked && model.turn?.isViewerTurn === true,
  };
}
