import type { ClientError } from '@repo/game-client-sdk/errors';
import { describe, expect, test } from 'vitest';

import {
  deriveGameInputReadiness,
  deriveGameInputScopes,
  deriveGameInteraction,
  deriveGameRecoveryPresentation,
} from '@/features/game/interaction/game-interaction';
import { deriveGameViewModel } from '@/features/game/ui/game-view-model';
import type { SessionRecoverySnapshot } from '@/runtime/session/session-recovery';
import { playingGame } from '@/testing/game-fixtures';

const ready = {
  phase: 'settled',
  hasPendingCommand: false,
  connected: true,
  deadlineReady: true,
  turnReady: true,
  recordFeedbackActive: false,
  layer: 'board',
  recoveryBlocked: false,
  recordedCategoryNoticeOpen: false,
} as const;

function inputScopes(
  input: Parameters<typeof deriveGameInputReadiness>[0] &
    Omit<Parameters<typeof deriveGameInputScopes>[0], 'readiness'>,
) {
  return deriveGameInputScopes({ ...input, readiness: deriveGameInputReadiness(input) });
}

describe('Game input scopes', () => {
  test.each([
    { phase: 'hidden', recordFeedbackActive: false },
    { phase: 'resolving', recordFeedbackActive: false },
    { phase: 'rolling', recordFeedbackActive: false },
    { phase: 'revealing', recordFeedbackActive: false },
    { phase: 'achievement', recordFeedbackActive: false },
    { phase: 'settled', recordFeedbackActive: true },
  ] as const)(
    'withholds cell and group previews together during $phase with record=$recordFeedbackActive',
    (presentation) => {
      const model = deriveGameViewModel(playingGame, 0);
      const scopes = inputScopes({ ...ready, ...presentation });
      const { boardModel } = deriveGameInteraction(model, scopes);

      expect(model.scoreRows.find((row) => row.categoryId === 'twos')?.previewScore).toBe(2);
      expect(boardModel.scoreRows.every((row) => row.previewScore === null)).toBe(true);
      expect(boardModel.scoreGroupPreviews).toEqual({ upper: null, lower: null });
      expect(boardModel.scoreRows.find((row) => row.categoryId === 'ones')?.viewerScore).toBe(2);
    },
  );

  test.each([{ hasPendingCommand: true }, { recoveryBlocked: true }, { layer: 'bonus' }] as const)(
    'retains settled preview data while a command or layer is locked: %j',
    (lock) => {
      const model = deriveGameViewModel(playingGame, 0);
      const scopes = inputScopes({ ...ready, ...lock });
      const interaction = deriveGameInteraction(model, scopes);

      expect(
        interaction.boardModel.scoreRows.find((row) => row.categoryId === 'twos')?.previewScore,
      ).toBe(2);
      expect(interaction.boardModel.scoreGroupPreviews).toEqual({ upper: 6, lower: 30 });
      expect(interaction.canScore).toBe(false);
      expect(interaction.canRoll).toBe(false);
      expect(interaction.canHold).toBe(false);
    },
  );

  test.each([
    { turnReady: false, recordFeedbackActive: false },
    { turnReady: true, recordFeedbackActive: true },
  ])('turn handoff blocks gameplay while allowing forfeit and exploration', (handoff) => {
    expect(inputScopes({ ...ready, ...handoff })).toMatchObject({
      commandBlocked: false,
      gameplayBlocked: true,
      boardInteractionLocked: true,
      canNavigateBoardLayers: true,
      canToggleBonus: true,
    });
  });
  test('allows settled gameplay and layer navigation', () => {
    expect(inputScopes(ready)).toMatchObject({
      commandBlocked: false,
      gameplayBlocked: false,
      recoveryBlocked: false,
      previewVisible: true,
      canToggleBonus: true,
    });
  });

  test('pending blocks commands while preserving settled previews and bonus navigation', () => {
    expect(inputScopes({ ...ready, hasPendingCommand: true })).toMatchObject({
      commandBlocked: true,
      gameplayBlocked: true,
      recoveryBlocked: false,
      previewVisible: true,
      canToggleBonus: true,
    });
  });

  test.each(['resolving', 'rolling', 'revealing'] as const)(
    '%s locks gameplay without blocking layer browsing or forfeit',
    (phase) => {
      expect(inputScopes({ ...ready, phase })).toMatchObject({
        commandBlocked: false,
        gameplayBlocked: true,
        boardInteractionLocked: true,
        recoveryBlocked: false,
        previewVisible: false,
        canToggleBonus: true,
      });
    },
  );

  test('achievement blocks gameplay while preserving existing layer browsing', () => {
    expect(inputScopes({ ...ready, phase: 'achievement', layer: 'bonus' })).toMatchObject({
      commandBlocked: false,
      gameplayBlocked: true,
      boardInteractionLocked: true,
      boardInert: false,
      recoveryBlocked: false,
      previewVisible: false,
      canToggleBonus: true,
    });
  });

  test('recovery and command notices block the underlying layers', () => {
    expect(inputScopes({ ...ready, recoveryBlocked: true, layer: 'settings' })).toMatchObject({
      gameplayBlocked: true,
      commandBlocked: true,
      recoveryBlocked: true,
      previewVisible: true,
    });
  });

  test.each(['settings', 'scoreboard', 'bonus'] as const)(
    '%s blocks gameplay without disabling the layer itself',
    (layer) => {
      expect(inputScopes({ ...ready, layer })).toMatchObject({
        gameplayBlocked: true,
        commandBlocked: false,
        recoveryBlocked: false,
        previewVisible: true,
      });
    },
  );

  test('a recorded-category notice blocks board navigation but leaves its confirmation usable', () => {
    expect(inputScopes({ ...ready, recordedCategoryNoticeOpen: true })).toMatchObject({
      gameplayBlocked: true,
      boardInert: true,
      recoveryBlocked: false,
      canNavigateBoardLayers: false,
      canToggleBonus: false,
    });
  });

  test.each([
    { connected: false, deadlineReady: true },
    { connected: true, deadlineReady: false },
  ])('unavailable gameplay timing or connection does not imply a layer lock', (state) => {
    expect(inputScopes({ ...ready, ...state })).toMatchObject({
      commandBlocked: true,
      gameplayBlocked: true,
      recoveryBlocked: false,
      canToggleBonus: true,
    });
  });
});

const retryError: ClientError = { kind: 'transport', code: 'ACK_TIMEOUT' };
const recoverySnapshots: readonly SessionRecoverySnapshot[] = [
  { status: 'idle' },
  { status: 'reconnecting' },
  { status: 'synchronizing' },
  { status: 'permanentFailure', error: retryError },
  { status: 'refreshRequired', error: null },
];

describe('Game recovery presentation', () => {
  for (const snapshot of recoverySnapshots) {
    test.each([
      { rateLimited: false, commandRetryError: null },
      { rateLimited: true, commandRetryError: null },
      { rateLimited: false, commandRetryError: retryError },
      { rateLimited: true, commandRetryError: retryError },
    ])(
      `${snapshot.status} preserves raw notices and selects the highest priority surface: %j`,
      (notices) => {
        const presentation = deriveGameRecoveryPresentation({ snapshot, ...notices });
        const recoveryActive = snapshot.status !== 'idle';
        const hasCommandNotice = notices.rateLimited || notices.commandRetryError !== null;
        expect(presentation).toMatchObject({
          recoveryActive,
          hasCommandNotice,
          recoveryBlocked: recoveryActive || hasCommandNotice,
        });
        if (snapshot.status === 'permanentFailure' || snapshot.status === 'refreshRequired') {
          expect(presentation.surface).toEqual({ kind: 'terminal', ...snapshot });
        } else if (snapshot.status === 'reconnecting' || snapshot.status === 'synchronizing') {
          expect(presentation.surface).toEqual({ kind: 'progress', status: snapshot.status });
        } else if (notices.rateLimited) {
          expect(presentation.surface).toEqual({ kind: 'rate-limited' });
        } else if (notices.commandRetryError !== null) {
          expect(presentation.surface).toEqual({ kind: 'retryable', error: retryError });
        } else {
          expect(presentation.surface).toEqual({ kind: 'none' });
        }
        expect(
          deriveGameInputReadiness({ ...ready, recoveryBlocked: presentation.recoveryBlocked })
            .requestReady,
        ).toBe(!presentation.recoveryBlocked);
      },
    );
  }
});
