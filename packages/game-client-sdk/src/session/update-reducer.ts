import {
  type CommandReceipt,
  type CommittedRoomUpdate,
  GAME_COMMAND_TYPE,
  type GameCommand,
  type ResolvedRollArtifact,
  ROOM_UPDATE_TYPE,
  type RoomView,
} from '@repo/game-protocol/socket';

export type GamePresentation =
  Readonly<{ kind: 'settled' }> | Readonly<{ kind: 'roll'; roll: ResolvedRollArtifact }>;

export interface SessionState {
  readonly view: RoomView | null;
  readonly presentation: GamePresentation | null;
}

export function createSessionState(): SessionState {
  return { view: null, presentation: null };
}

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

/** Full-state recovery confirms the present; it never supplies a historical roll to replay. */
export function reduceRestoredView(state: SessionState, view: RoomView): UpdateReduction {
  const reduction = reduceRoomView(state, view);
  if (reduction.kind === 'invalid') return reduction;
  if ((view.game?.stateVersion ?? 0) < (state.view?.game?.stateVersion ?? 0)) return reduction;
  const restored = reduction.state;
  const presentation = settledPresentation(restored.view);
  if (restored.presentation?.kind === 'roll') {
    return { ...reduction, state: { ...restored, presentation } };
  }
  return reduction;
}

export function reduceCommittedUpdate(
  state: SessionState,
  update: CommittedRoomUpdate,
): UpdateReduction {
  const reduction = reduceRoomView(state, update.view);
  if (reduction.kind !== 'applied' || update.type !== ROOM_UPDATE_TYPE.ROLL_COMMITTED) {
    return reduction;
  }
  return withFreshRoll(state, reduction, update.roll, update.view.game?.stateVersion ?? 0);
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
  if (reduction.kind !== 'applied' || !('roll' in receipt)) return reduction;
  return withFreshRoll(state, reduction, receipt.roll, receipt.stateVersion);
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
