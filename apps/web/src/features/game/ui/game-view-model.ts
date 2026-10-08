import {
  CATEGORY_IDS,
  type CategoryId,
  type Dice,
  type DieFace,
  type DieSlot,
  LOWER_CATEGORY_IDS,
  MAX_ROLLS_PER_TURN,
  MAX_TURNS_PER_PLAYER,
  previewScores,
  type Scorecard,
  type ScoreSummary,
  type SeatIndex,
  summarizeScorecard,
  turnsUsed,
  UPPER_CATEGORY_IDS,
} from '@repo/yacht-rules';

type PlayerViewInput = Readonly<{
  scorecard: Scorecard;
  timeoutCount: 0 | 1 | 2 | 3;
}>;

type PlayersViewInput = readonly [PlayerViewInput, PlayerViewInput];

type DieViewInput = Readonly<{
  value: DieFace;
}>;

type DiceViewInput = readonly [
  DieViewInput,
  DieViewInput,
  DieViewInput,
  DieViewInput,
  DieViewInput,
];

type TurnViewInput = Readonly<{
  seatIndex: SeatIndex;
  rollCount: 0 | 1 | 2 | 3;
  dice: DiceViewInput | null;
  heldSlots: readonly DieSlot[];
}>;

export type GameViewInput = Readonly<{
  match:
    | Readonly<{
        status: 'playing';
        players: PlayersViewInput;
        currentTurn: TurnViewInput;
      }>
    | Readonly<{
        status: 'finished';
        players: PlayersViewInput;
      }>;
}>;

export type DiceSlotViewModel = Readonly<{
  slot: DieSlot;
  value: DieFace;
  held: boolean;
}>;

export type DiceViewModel = readonly [
  DiceSlotViewModel,
  DiceSlotViewModel,
  DiceSlotViewModel,
  DiceSlotViewModel,
  DiceSlotViewModel,
];

export type ScoreRowViewModel = Readonly<{
  categoryId: CategoryId;
  viewerScore: number | null;
  opponentScore: number | null;
  /** Unrecorded category preview for the current turn player, independent of viewer authority. */
  previewScore: number | null;
  selectable: boolean;
}>;

export type ScoreGroupPreviewsViewModel = Readonly<{
  upper: number | null;
  lower: number | null;
}>;

type PlayerScoreViewModel = Readonly<{ seatIndex: SeatIndex }> & ScoreSummary;

export type GameViewModel = Readonly<{
  viewer: PlayerScoreViewModel;
  opponent: PlayerScoreViewModel;
  turn: null | Readonly<{
    isViewerTurn: boolean;
    ordinal: number;
    total: typeof MAX_TURNS_PER_PLAYER;
    rollCount: 0 | 1 | 2 | 3;
    showFirstRollGuide: boolean;
    dice: readonly [] | DiceViewModel;
    heldSlots: readonly DieSlot[];
  }>;
  scoreRows: readonly ScoreRowViewModel[];
  scoreGroupPreviews: ScoreGroupPreviewsViewModel;
  actions: Readonly<{
    canRoll: boolean;
    canHold: boolean;
    canScore: boolean;
  }>;
}>;

function scoreOf(scorecard: Scorecard, id: CategoryId): number | null {
  return scorecard[id] ?? null;
}

function highestPreviewScore(
  previews: ReturnType<typeof previewScores>,
  categoryIds: readonly CategoryId[],
): number | null {
  let highest: number | null = null;
  for (const categoryId of categoryIds) {
    const preview = previews[categoryId];
    if (preview.recorded || preview.score === null) continue;
    highest = highest === null ? preview.score : Math.max(highest, preview.score);
  }
  return highest;
}

export function deriveGameViewModel(
  snapshot: GameViewInput,
  viewerSeatIndex: SeatIndex,
): GameViewModel {
  const opponentSeatIndex: SeatIndex = viewerSeatIndex === 0 ? 1 : 0;
  const viewer = snapshot.match.players[viewerSeatIndex];
  const opponent = snapshot.match.players[opponentSeatIndex];

  const turn = snapshot.match.status === 'playing' ? snapshot.match.currentTurn : null;
  const isViewerTurn = turn?.seatIndex === viewerSeatIndex;
  const hasDice = turn?.dice !== null && turn?.dice !== undefined;
  const allDiceHeld = hasDice && turn.heldSlots.length === 5;
  const diceValues: Dice | null = turn?.dice
    ? [
        turn.dice[0].value,
        turn.dice[1].value,
        turn.dice[2].value,
        turn.dice[3].value,
        turn.dice[4].value,
      ]
    : null;
  const previewScorecard =
    turn === null ? viewer.scorecard : snapshot.match.players[turn.seatIndex].scorecard;
  const previews = previewScores(previewScorecard, diceValues);
  const scoreRows = CATEGORY_IDS.map((categoryId) => ({
    categoryId,
    viewerScore: scoreOf(viewer.scorecard, categoryId),
    opponentScore: scoreOf(opponent.scorecard, categoryId),
    previewScore: previews[categoryId].recorded ? null : previews[categoryId].score,
    selectable: Boolean(isViewerTurn && previews[categoryId].selectable),
  }));
  const viewerSummary = summarizeScorecard(viewer.scorecard);
  const opponentSummary = summarizeScorecard(opponent.scorecard);

  return {
    viewer: {
      seatIndex: viewerSeatIndex,
      total: viewerSummary.total,
      upperSubtotal: viewerSummary.upperSubtotal,
      upperBonus: viewerSummary.upperBonus,
    },
    opponent: {
      seatIndex: opponentSeatIndex,
      total: opponentSummary.total,
      upperSubtotal: opponentSummary.upperSubtotal,
      upperBonus: opponentSummary.upperBonus,
    },
    turn: turn
      ? {
          isViewerTurn: Boolean(isViewerTurn),
          ordinal: turnsUsed(snapshot.match.players[turn.seatIndex]) + 1,
          total: MAX_TURNS_PER_PLAYER,
          rollCount: turn.rollCount,
          heldSlots: turn.heldSlots,
          showFirstRollGuide: Boolean(
            isViewerTurn && turnsUsed(viewer) === 0 && turn.rollCount === 0,
          ),
          dice: turn.dice
            ? [
                { slot: 0, value: turn.dice[0].value, held: turn.heldSlots.includes(0) },
                { slot: 1, value: turn.dice[1].value, held: turn.heldSlots.includes(1) },
                { slot: 2, value: turn.dice[2].value, held: turn.heldSlots.includes(2) },
                { slot: 3, value: turn.dice[3].value, held: turn.heldSlots.includes(3) },
                { slot: 4, value: turn.dice[4].value, held: turn.heldSlots.includes(4) },
              ]
            : [],
        }
      : null,
    scoreRows,
    scoreGroupPreviews: {
      upper: highestPreviewScore(previews, UPPER_CATEGORY_IDS),
      lower: highestPreviewScore(previews, LOWER_CATEGORY_IDS),
    },
    actions: {
      canRoll: Boolean(isViewerTurn && turn && turn.rollCount < MAX_ROLLS_PER_TURN && !allDiceHeld),
      canHold: Boolean(isViewerTurn && hasDice && turn && turn.rollCount < MAX_ROLLS_PER_TURN),
      canScore: Boolean(isViewerTurn && hasDice),
    },
  };
}
