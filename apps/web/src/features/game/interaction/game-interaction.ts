import type { ClientError } from '@repo/game-client-sdk/errors';

import type { GameViewModel } from '@/features/game/view/game-view-model';
import type { DicePresentationSnapshot } from '@/runtime/dice/dice-presentation';
import type { SessionRecoverySnapshot } from '@/runtime/session/session-recovery';

export type GameLayer = 'board' | 'bonus' | 'scoreboard' | 'settings';

export type GameRecoveryPresentation = Readonly<{
  recoveryActive: boolean;
  hasCommandNotice: boolean;
  recoveryBlocked: boolean;
  surface:
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'progress'; status: 'reconnecting' | 'synchronizing' }>
    | (Readonly<{ kind: 'terminal' }> &
        Extract<SessionRecoverySnapshot, { status: 'permanentFailure' | 'refreshRequired' }>)
    | Readonly<{ kind: 'rate-limited' }>
    | Readonly<{ kind: 'retryable'; error: ClientError }>;
}>;

export function deriveGameRecoveryPresentation({
  snapshot,
  rateLimited,
  commandRetryError,
}: Readonly<{
  snapshot: SessionRecoverySnapshot;
  rateLimited: boolean;
  commandRetryError: ClientError | null;
}>): GameRecoveryPresentation {
  const recoveryActive = snapshot.status !== 'idle';
  const hasCommandNotice = rateLimited || commandRetryError !== null;
  const surface: GameRecoveryPresentation['surface'] =
    snapshot.status === 'permanentFailure' || snapshot.status === 'refreshRequired'
      ? { kind: 'terminal', ...snapshot }
      : snapshot.status === 'reconnecting' || snapshot.status === 'synchronizing'
        ? { kind: 'progress', status: snapshot.status }
        : rateLimited
          ? { kind: 'rate-limited' }
          : commandRetryError !== null
            ? { kind: 'retryable', error: commandRetryError }
            : { kind: 'none' };
  return {
    recoveryActive,
    hasCommandNotice,
    recoveryBlocked: recoveryActive || hasCommandNotice,
    surface,
  };
}

export function deriveGameInputReadiness({
  phase,
  hasPendingCommand,
  connected,
  recoveryBlocked,
}: Readonly<{
  phase: DicePresentationSnapshot['phase'];
  hasPendingCommand: boolean;
  connected: boolean;
  recoveryBlocked: boolean;
}>) {
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
