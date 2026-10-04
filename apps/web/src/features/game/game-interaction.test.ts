import { describe, expect, test } from 'vitest';

import { deriveGameInputScopes } from '@/features/game/game-interaction';

const ready = {
  phase: 'settled',
  hasPendingCommand: false,
  connected: true,
  secondsRemaining: 30,
  layer: 'board',
  recoveryActive: false,
  hasCommandNotice: false,
  recordedCategoryNoticeOpen: false,
} as const;

describe('Game input scopes', () => {
  test('allows settled gameplay and layer navigation', () => {
    expect(deriveGameInputScopes(ready)).toMatchObject({
      commandBlocked: false,
      gameplayBlocked: false,
      recoveryBlocked: false,
      previewVisible: true,
      canToggleBonus: true,
    });
  });

  test('pending blocks commands while preserving settled previews and bonus navigation', () => {
    expect(deriveGameInputScopes({ ...ready, hasPendingCommand: true })).toMatchObject({
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
      expect(deriveGameInputScopes({ ...ready, phase })).toMatchObject({
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
    expect(deriveGameInputScopes({ ...ready, phase: 'achievement', layer: 'bonus' })).toMatchObject(
      {
        commandBlocked: false,
        gameplayBlocked: true,
        boardInteractionLocked: true,
        boardInert: false,
        recoveryBlocked: false,
        previewVisible: false,
        canToggleBonus: true,
      },
    );
  });

  test.each([
    { recoveryActive: true, hasCommandNotice: false },
    { recoveryActive: false, hasCommandNotice: true },
    { recoveryActive: true, hasCommandNotice: true },
  ])('recovery and command notices block the underlying layers', (overlay) => {
    expect(deriveGameInputScopes({ ...ready, ...overlay, layer: 'settings' })).toMatchObject({
      gameplayBlocked: true,
      commandBlocked: true,
      recoveryBlocked: true,
      previewVisible: true,
    });
  });

  test.each(['settings', 'scoreboard', 'bonus'] as const)(
    '%s blocks gameplay without disabling the layer itself',
    (layer) => {
      expect(deriveGameInputScopes({ ...ready, layer })).toMatchObject({
        gameplayBlocked: true,
        commandBlocked: false,
        recoveryBlocked: false,
        previewVisible: true,
      });
    },
  );

  test('a recorded-category notice blocks board navigation but leaves its confirmation usable', () => {
    expect(deriveGameInputScopes({ ...ready, recordedCategoryNoticeOpen: true })).toMatchObject({
      gameplayBlocked: true,
      boardInert: true,
      recoveryBlocked: false,
      canNavigateBoardLayers: false,
      canToggleBonus: false,
    });
  });

  test.each([
    { connected: false, secondsRemaining: 30 },
    { connected: true, secondsRemaining: null },
    { connected: true, secondsRemaining: 0 },
  ])('unavailable gameplay timing or connection does not imply a layer lock', (state) => {
    expect(deriveGameInputScopes({ ...ready, ...state })).toMatchObject({
      commandBlocked: true,
      gameplayBlocked: true,
      recoveryBlocked: false,
      canToggleBonus: true,
    });
  });
});
