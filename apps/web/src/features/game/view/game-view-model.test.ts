import { describe, expect, test } from 'vitest';

import { deriveGameViewModel, type GameViewInput } from '@/features/game/view/game-view-model';

const viewerSeatIndex = 0;
const opponentSeatIndex = 1;

const playing = {
  match: {
    status: 'playing',
    players: [
      { scorecard: { ones: 3 }, timeoutCount: 0 },
      {
        scorecard: { yacht: 50 },
        timeoutCount: 1,
      },
    ],
    currentTurn: {
      seatIndex: viewerSeatIndex,
      rollCount: 1,
      heldSlots: [1],
      dice: [{ value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }, { value: 6 }],
    },
  },
} satisfies GameViewInput;

describe('deriveGameViewModel', () => {
  test('derives viewer-relative actions, dice, previews, totals, and score summaries', () => {
    const model = deriveGameViewModel(playing, viewerSeatIndex);
    expect(model).toMatchObject({
      viewer: { seatIndex: viewerSeatIndex, total: 3, upperSubtotal: 3, upperBonus: 0 },
      opponent: { seatIndex: opponentSeatIndex, total: 50, upperSubtotal: 0, upperBonus: 0 },
      actions: { canRoll: true, canHold: true, canScore: true },
      turn: { isViewerTurn: true, ordinal: 2, total: 12, rollCount: 1 },
    });
    expect(model.turn?.dice[1]).toEqual({ slot: 1, value: 6, held: true });
    expect(model.scoreRows.find(({ categoryId }) => categoryId === 'yacht')).toMatchObject({
      previewScore: 50,
      selectable: true,
    });
    expect(model.scoreRows.find(({ categoryId }) => categoryId === 'ones')).toMatchObject({
      viewerScore: 3,
      previewScore: null,
      selectable: false,
    });
    expect(model.scoreGroupPreviews).toEqual({ upper: 30, lower: 50 });
  });

  test('keeps awarded bonus and totals together when the viewer seat changes', () => {
    const scored = {
      ...playing,
      match: {
        ...playing.match,
        players: [
          {
            scorecard: { ones: 3, twos: 6, threes: 9, fours: 12, fives: 15, sixes: 18, yacht: 50 },
            timeoutCount: 0,
          },
          playing.match.players[1],
        ],
      },
    } satisfies GameViewInput;
    const firstViewer = deriveGameViewModel(scored, 0);
    const secondViewer = deriveGameViewModel(scored, 1);
    expect(firstViewer.viewer).toEqual({
      seatIndex: 0,
      total: 148,
      upperSubtotal: 63,
      upperBonus: 35,
    });
    expect(secondViewer.opponent).toEqual(firstViewer.viewer);
    expect(secondViewer.viewer).toEqual(firstViewer.opponent);
  });

  test('excludes recorded categories while preserving a valid zero-point group preview', () => {
    const recordedHighScores = {
      ...playing,
      match: {
        ...playing.match,
        players: [
          {
            scorecard: { ones: 3, sixes: 30, yacht: 50 },
            timeoutCount: 0,
          },
          playing.match.players[1],
        ],
      },
    } satisfies GameViewInput;

    expect(deriveGameViewModel(recordedHighScores, viewerSeatIndex).scoreGroupPreviews).toEqual({
      upper: 0,
      lower: 30,
    });
  });

  test('hides score group previews before the first roll and during the opponent turn', () => {
    const beforeFirstRoll = {
      ...playing,
      match: {
        ...playing.match,
        currentTurn: {
          ...playing.match.currentTurn,
          rollCount: 0,
          heldSlots: [],
          dice: null,
        },
      },
    } satisfies GameViewInput;
    const opponentTurn = {
      ...playing,
      match: {
        ...playing.match,
        currentTurn: { ...playing.match.currentTurn, seatIndex: opponentSeatIndex },
      },
    } satisfies GameViewInput;

    expect(deriveGameViewModel(beforeFirstRoll, viewerSeatIndex).scoreGroupPreviews).toEqual({
      upper: null,
      lower: null,
    });
    expect(deriveGameViewModel(opponentTurn, viewerSeatIndex).scoreGroupPreviews).toEqual({
      upper: null,
      lower: null,
    });
  });

  test('derives the turn ordinal from the current player turns used', () => {
    const opponentTurn = {
      ...playing,
      match: {
        ...playing.match,
        currentTurn: { ...playing.match.currentTurn, seatIndex: opponentSeatIndex },
      },
    } satisfies GameViewInput;

    expect(deriveGameViewModel(opponentTurn, viewerSeatIndex).turn).toMatchObject({
      isViewerTurn: false,
      ordinal: 3,
      total: 12,
    });
  });

  test('shows the first-roll guide only before the viewer first rolls in a match', () => {
    const viewerFirstTurn = {
      ...playing,
      match: {
        ...playing.match,
        players: [{ scorecard: {}, timeoutCount: 0 }, playing.match.players[1]],
        currentTurn: {
          ...playing.match.currentTurn,
          rollCount: 0,
          heldSlots: [],
          dice: null,
        },
      },
    } satisfies GameViewInput;

    expect(deriveGameViewModel(viewerFirstTurn, viewerSeatIndex).turn?.showFirstRollGuide).toBe(
      true,
    );
    expect(deriveGameViewModel(playing, viewerSeatIndex).turn?.showFirstRollGuide).toBe(false);
  });

  test('disables turn actions after the match finishes', () => {
    const finished = {
      ...playing,
      match: {
        status: 'finished',
        players: playing.match.players,
      },
    } satisfies GameViewInput;
    const model = deriveGameViewModel(finished, viewerSeatIndex);
    expect(model.turn).toBeNull();
    expect(model.actions).toEqual({
      canRoll: false,
      canHold: false,
      canScore: false,
    });
  });

  test('disables rolling when every die is held and holding after the final roll', () => {
    const allHeld = {
      ...playing,
      match: {
        ...playing.match,
        currentTurn: {
          ...playing.match.currentTurn,
          rollCount: 2,
          heldSlots: [0, 1, 2, 3, 4],
        },
      },
    } satisfies GameViewInput;
    expect(deriveGameViewModel(allHeld, viewerSeatIndex).actions).toMatchObject({
      canRoll: false,
      canHold: true,
      canScore: true,
    });

    const finalRoll = {
      ...playing,
      match: {
        ...playing.match,
        currentTurn: { ...playing.match.currentTurn, rollCount: 3 },
      },
    } satisfies GameViewInput;
    expect(deriveGameViewModel(finalRoll, viewerSeatIndex).actions).toMatchObject({
      canRoll: false,
      canHold: false,
      canScore: true,
    });
  });
});
