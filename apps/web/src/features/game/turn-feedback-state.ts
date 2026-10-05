import type { GamePresentation, ScoreRecord } from '@repo/game-client-sdk/session';
import type { GameSnapshot } from '@repo/game-protocol/socket';
import { type SeatIndex, summarizeScorecard, UPPER_CATEGORY_IDS } from '@repo/yacht-rules';

export const RECORD_CONFIRMATION_MS = 1_000;
export const RECORD_FADE_OUT_MS = 800;
export const RECORD_SWAP_MS = 900;
export const TURN_CUE_MS = 650;

export interface TurnFeedbackInput {
  readonly session: object | null;
  readonly game: GameSnapshot | null;
  readonly presentation: GamePresentation | null;
  readonly viewerSeat: SeatIndex | null;
  readonly now: number;
  readonly serverNow: number | null;
  readonly suspended: boolean;
  readonly scoreVisible: boolean;
  readonly boardVisible: boolean;
  readonly canStartTurn: boolean;
  readonly rollPending: boolean;
}

interface ActiveRecord {
  readonly record: ScoreRecord;
  readonly startedAt: number;
  readonly phase: 'confirming' | 'outgoing' | 'incoming';
  readonly bonusEarned: boolean;
  readonly final: boolean;
  readonly visible: boolean;
}

interface TurnCue {
  readonly turnId: string;
  readonly startedAt: number;
}

interface PendingTurn extends TurnCue {
  readonly waitingForInput: boolean;
}

export interface TurnFeedbackState {
  readonly session: object | null;
  readonly consumedVersion: number;
  readonly record: ActiveRecord | null;
  readonly pendingTurn: PendingTurn | null;
  readonly turnCue: TurnCue | null;
  readonly tabRequest: Readonly<{ version: number; group: 'upper' | 'lower' }> | null;
}

export function createTurnFeedbackState(): TurnFeedbackState {
  return {
    session: null,
    consumedVersion: -1,
    record: null,
    pendingTurn: null,
    turnCue: null,
    tabRequest: null,
  };
}

function earnedBonus(game: GameSnapshot, record: ScoreRecord): boolean {
  const after = game.match.players[record.seatIndex].scorecard;
  const before = { ...after };
  delete before[record.categoryId];
  return summarizeScorecard(before).upperBonus === 0 && summarizeScorecard(after).upperBonus > 0;
}

/** Consumes accepted SDK facts; it never advances or restores authoritative game state. */
export function advanceTurnFeedback(
  previous: TurnFeedbackState,
  input: TurnFeedbackInput,
): TurnFeedbackState {
  const initial =
    previous.session === input.session
      ? previous
      : { ...createTurnFeedbackState(), session: input.session };
  let { consumedVersion, record, pendingTurn, turnCue, tabRequest } = initial;
  const { game, presentation, now, serverNow } = input;
  const turn = game?.match.status === 'playing' ? game.match.currentTurn : null;
  const sourceVersion =
    presentation?.kind === 'score'
      ? presentation.record.stateVersion
      : presentation?.kind === 'turn'
        ? (game?.stateVersion ?? -1)
        : -1;

  if (input.suspended || game === null || input.session === null) {
    consumedVersion = Math.max(consumedVersion, sourceVersion);
    record = null;
    pendingTurn = null;
    turnCue = null;
    tabRequest = null;
  } else {
    if (
      record !== null &&
      (game.stateVersion !== record.record.stateVersion ||
        presentation?.kind !== 'score' ||
        presentation.record.stateVersion !== record.record.stateVersion)
    ) {
      record = null;
      pendingTurn = null;
    }

    if (sourceVersion > consumedVersion) {
      consumedVersion = sourceVersion;
      if (presentation?.kind === 'score') {
        tabRequest = {
          version: sourceVersion,
          group: UPPER_CATEGORY_IDS.some((category) => category === presentation.record.categoryId)
            ? 'upper'
            : 'lower',
        };
        const final =
          game.match.status === 'finished' && game.match.result.reason === 'scoresCompleted';
        const fresh =
          (final && input.scoreVisible) ||
          (turn !== null && serverNow !== null && serverNow < turn.startedAt);
        if (fresh) {
          record = {
            record: presentation.record,
            startedAt: now,
            phase: 'confirming',
            bonusEarned: earnedBonus(game, presentation.record),
            final,
            visible: input.scoreVisible,
          };
          pendingTurn =
            turn !== null && turn.seatIndex === input.viewerSeat && serverNow !== null
              ? {
                  turnId: turn.turnId,
                  startedAt: Math.max(
                    now + RECORD_CONFIRMATION_MS,
                    now + turn.startedAt - serverNow,
                  ),
                  waitingForInput: false,
                }
              : null;
        }
      } else if (
        presentation?.kind === 'turn' &&
        turn !== null &&
        turn.turnId === presentation.turnId &&
        turn.seatIndex === input.viewerSeat &&
        serverNow !== null
      ) {
        pendingTurn = {
          turnId: turn.turnId,
          startedAt: now + Math.max(0, turn.startedAt - serverNow),
          waitingForInput: false,
        };
      }
    }

    if (record !== null) {
      const elapsed = now - record.startedAt;
      if (elapsed >= RECORD_CONFIRMATION_MS) {
        record = null;
      } else {
        const phase = record.final
          ? 'confirming'
          : elapsed >= RECORD_SWAP_MS
            ? 'incoming'
            : elapsed >= RECORD_FADE_OUT_MS
              ? 'outgoing'
              : 'confirming';
        const visible = record.visible && input.scoreVisible;
        if (record.phase !== phase || record.visible !== visible)
          record = { ...record, phase, visible };
      }
    }

    const currentTurn =
      turn !== null && turn.seatIndex === input.viewerSeat && turn.rollCount === 0;
    if (!currentTurn || input.rollPending || presentation?.kind === 'settled') {
      pendingTurn = null;
      turnCue = null;
    } else {
      if (pendingTurn !== null && pendingTurn.turnId !== turn.turnId) pendingTurn = null;
      if (turnCue !== null && turnCue.turnId !== turn.turnId) turnCue = null;
      if (pendingTurn !== null && record === null && now >= pendingTurn.startedAt) {
        if (serverNow !== null && serverNow < turn.startedAt) {
          pendingTurn = {
            ...pendingTurn,
            startedAt: now + turn.startedAt - serverNow,
            waitingForInput: false,
          };
        } else if (!input.boardVisible || serverNow === null || serverNow >= turn.deadlineAt) {
          pendingTurn = null;
        } else if (!input.canStartTurn) {
          if (!pendingTurn.waitingForInput) {
            pendingTurn =
              now < pendingTurn.startedAt + TURN_CUE_MS
                ? { ...pendingTurn, waitingForInput: true }
                : null;
          }
        } else {
          const cueStartedAt = pendingTurn.waitingForInput ? now : pendingTurn.startedAt;
          if (now < cueStartedAt + TURN_CUE_MS)
            turnCue = { turnId: pendingTurn.turnId, startedAt: cueStartedAt };
          pendingTurn = null;
        }
      }
      if (turnCue !== null && (!input.boardVisible || now >= turnCue.startedAt + TURN_CUE_MS))
        turnCue = null;
    }
  }
  if (
    initial === previous &&
    consumedVersion === previous.consumedVersion &&
    record === previous.record &&
    pendingTurn === previous.pendingTurn &&
    turnCue === previous.turnCue &&
    tabRequest === previous.tabRequest
  )
    return previous;
  return { session: input.session, consumedVersion, record, pendingTurn, turnCue, tabRequest };
}

export function nextFeedbackBoundary(state: TurnFeedbackState): number | null {
  const { record, pendingTurn, turnCue } = state;
  if (record !== null)
    return (
      record.startedAt +
      (record.final
        ? RECORD_CONFIRMATION_MS
        : record.phase === 'confirming'
          ? RECORD_FADE_OUT_MS
          : record.phase === 'outgoing'
            ? RECORD_SWAP_MS
            : RECORD_CONFIRMATION_MS)
    );
  if (pendingTurn !== null && !pendingTurn.waitingForInput) return pendingTurn.startedAt;
  return turnCue === null ? null : turnCue.startedAt + TURN_CUE_MS;
}
