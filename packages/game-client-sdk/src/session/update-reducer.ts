import {
  type CommandReceipt,
  type CommittedRoomUpdate,
  GAME_COMMAND_TYPE,
  type GameCommand,
  type ResolvedRollArtifact,
  ROOM_UPDATE_TYPE,
  type RoomView,
} from '@repo/game-protocol/socket';

import { freshScoreRecord, isFreshTimeoutTurn, type ScoreRecord } from './score-transition';

export type { ScoreRecord } from './score-transition';

/**
 * Provenance for the current game version, retained across duplicate and presence-only views.
 * Current or newer recovery settles it; it is not a queue of one-time events.
 */
export type GamePresentation =
  | Readonly<{ kind: 'settled' }>
  | Readonly<{ kind: 'roll'; roll: ResolvedRollArtifact }>
  | Readonly<{ kind: 'score'; record: ScoreRecord }>
  | Readonly<{ kind: 'turn'; turnId: ScoreRecord['completedTurnId'] }>;

export interface SessionState {
  readonly view: RoomView | null;
  readonly presentation: GamePresentation | null;
}

export function createSessionState(): SessionState {
  return { view: null, presentation: null };
}

/**
 * kind describes RoomView acceptance, not whether the whole session state changed.
 * An ignored full sync can still settle an ephemeral presentation; callers use the returned state.
 */
export type UpdateReduction =
  | { readonly kind: 'applied' | 'ignored'; readonly state: SessionState }
  | { readonly kind: 'invalid' };

/** Authority advances as one view. Crossing counters cannot describe one ordered room history. */
export function reduceRoomView(state: SessionState, view: RoomView): UpdateReduction {
  const current = state.view;
  if (current !== null) {
    if (current.room.roomId !== view.room.roomId) return { kind: 'invalid' };
    const gameDelta = (view.game?.stateVersion ?? 0) - (current.game?.stateVersion ?? 0);
    const presenceDelta = view.presence.presenceVersion - current.presence.presenceVersion;
    if ((gameDelta < 0 && presenceDelta > 0) || (gameDelta > 0 && presenceDelta < 0)) {
      return { kind: 'invalid' };
    }
    if (gameDelta <= 0 && presenceDelta <= 0) return { kind: 'ignored', state };
  }
  return {
    kind: 'applied',
    state: {
      view,
      presentation:
        current !== null && current.game?.stateVersion === view.game?.stateVersion
          ? state.presentation
          : settledPresentation(view),
    },
  };
}

/** Full-state recovery confirms the present; it never supplies a historical event to replay. */
export function reduceRestoredView(state: SessionState, view: RoomView): UpdateReduction {
  const reduction = reduceRoomView(state, view);
  if (reduction.kind === 'invalid') return reduction;
  if ((view.game?.stateVersion ?? 0) < (state.view?.game?.stateVersion ?? 0)) return reduction;
  const restored = reduction.state;
  const presentation = settledPresentation(restored.view);
  if (restored.presentation !== null && restored.presentation.kind !== 'settled') {
    return { ...reduction, state: { ...restored, presentation } };
  }
  return reduction;
}

export function reduceCommittedUpdate(
  state: SessionState,
  update: CommittedRoomUpdate,
): UpdateReduction {
  const reduction = reduceRoomView(state, update.view);
  if (reduction.kind !== 'applied') return reduction;
  if (update.type === ROOM_UPDATE_TYPE.ROLL_COMMITTED)
    return withFreshRoll(state, reduction, update.roll, update.view.game?.stateVersion ?? 0);
  const { game } = update.view;
  if (game?.match.status === 'playing' && state.view?.room.status === 'waiting') {
    if (game.stateVersion === 1 && game.match.currentTurn.rollCount === 0) {
      return {
        ...reduction,
        state: {
          ...reduction.state,
          presentation: { kind: 'turn', turnId: game.match.currentTurn.turnId },
        },
      };
    }
  }
  const previous = state.view?.game;
  if (!previous || !game) return reduction;
  const record = freshScoreRecord(previous, game);
  if (record) {
    return { ...reduction, state: { ...reduction.state, presentation: { kind: 'score', record } } };
  }
  if (game.match.status === 'playing' && isFreshTimeoutTurn(previous, game)) {
    return {
      ...reduction,
      state: {
        ...reduction.state,
        presentation: { kind: 'turn', turnId: game.match.currentTurn.turnId },
      },
    };
  }
  return reduction;
}

export function reduceCommandView(
  state: SessionState,
  data: Readonly<{ receipt: CommandReceipt; view: RoomView }>,
  command: GameCommand,
): UpdateReduction {
  const { receipt, view } = data;
  if (
    command.type === GAME_COMMAND_TYPE.ROLL_DICE &&
    receipt.stateVersion === view.game?.stateVersion &&
    (view.game.match.status !== 'playing' || view.game.match.currentTurn.turnId !== command.turnId)
  ) {
    return { kind: 'invalid' };
  }
  const reduction = reduceRoomView(state, view);
  if (reduction.kind !== 'applied') return reduction;
  if ('roll' in receipt) return withFreshRoll(state, reduction, receipt.roll, receipt.stateVersion);
  const previous = state.view?.game;
  if (
    command.type !== GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY ||
    !previous ||
    !view.game ||
    receipt.stateVersion !== view.game.stateVersion
  ) {
    return reduction;
  }
  const record = freshScoreRecord(previous, view.game);
  if (
    !record ||
    record.completedTurnId !== command.turnId ||
    record.categoryId !== command.categoryId
  )
    return reduction;
  return { ...reduction, state: { ...reduction.state, presentation: { kind: 'score', record } } };
}

function withFreshRoll(
  previous: SessionState,
  reduction: Extract<UpdateReduction, { readonly state: SessionState }>,
  roll: ResolvedRollArtifact,
  receiptVersion: number,
): UpdateReduction {
  const previousGame = previous.view?.game;
  const game = reduction.state.view?.game;
  if (
    previousGame?.match.status !== 'playing' ||
    game?.match.status !== 'playing' ||
    game.stateVersion !== previousGame.stateVersion + 1 ||
    receiptVersion !== game.stateVersion ||
    game.match.currentTurn.turnId !== previousGame.match.currentTurn.turnId
  ) {
    return reduction;
  }
  return {
    ...reduction,
    state: {
      ...reduction.state,
      presentation: {
        kind: 'roll',
        roll,
      },
    },
  };
}

function settledPresentation(view: RoomView | null): SessionState['presentation'] {
  return view?.game ? { kind: 'settled' } : null;
}
