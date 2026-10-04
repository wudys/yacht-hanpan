import type { SeatIndex } from '@repo/yacht-rules';

import { reconnectDeadlineIsDue, type RoomEventTime } from '@/rooms/domain/event-time';
import {
  applyTurnExpiryDecision,
  endMatchForConnection,
  evaluateTurnExpiry,
  type TurnExpiryDecision,
} from '@/rooms/domain/match/match-lifecycle';
import type { NextTurnInput } from '@/rooms/domain/match/model';
import { earliestReconnectDeadline } from '@/rooms/domain/reconnect-policy';
import { finishRoomMatch } from '@/rooms/domain/room-lifecycle';
import type { FinishedRoomState, PlayingRoomState } from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';

export type RoomDeadlineDecision =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'connectionEnded'; readonly losingSeatIndex: SeatIndex }
  | {
      readonly kind: 'timeout';
      readonly expiry: TurnExpiryDecision;
      readonly connectionAfterTimeout: SeatIndex | null;
    };

export type DeadlineReconciliation =
  | { readonly changed: false; readonly state: PlayingRoomState }
  | { readonly changed: true; readonly state: PlayingRoomState | FinishedRoomState };

type RoomDeadlineApplication =
  | (Exclude<RoomDeadlineDecision, { readonly kind: 'timeout' }> & {
      readonly committedAt: number;
    })
  | (Extract<RoomDeadlineDecision, { readonly kind: 'timeout' }> & {
      readonly committedAt: number;
      readonly nextTurn: NextTurnInput;
    });

export function nextRoomDeadline(state: PlayingRoomState): number {
  const reconnect = earliestReconnectDeadline(state.room);
  return Math.min(
    state.match.currentTurn.deadlineAt,
    reconnect?.reconnectDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
}

export function evaluateRoomDeadlines(
  current: PlayingRoomState,
  time: RoomEventTime,
): RoomDeadlineDecision {
  const turnDeadline = Number(current.match.currentTurn.deadlineAt);
  const disconnected = earliestReconnectDeadline(current.room);
  const connectionDue =
    disconnected !== null && reconnectDeadlineIsDue(time, disconnected.reconnectDeadlineAt);
  const reconnectDeadline = connectionDue
    ? disconnected.reconnectDeadlineAt
    : Number.POSITIVE_INFINITY;
  const turnDue = turnDeadline <= time.effectiveAt;

  if (connectionDue && reconnectDeadline < turnDeadline) {
    return { kind: 'connectionEnded', losingSeatIndex: disconnected.seatIndex };
  }
  if (!turnDue) return { kind: 'unchanged' };

  return {
    kind: 'timeout',
    expiry: evaluateTurnExpiry(current.match, {
      expectedTurnId: current.match.currentTurn.id,
      checkedAt: epochMilliseconds(time.effectiveAt),
    }),
    connectionAfterTimeout: connectionDue ? disconnected.seatIndex : null,
  };
}

export function applyRoomDeadlineDecision(
  current: PlayingRoomState,
  input: RoomDeadlineApplication,
): DeadlineReconciliation {
  if (input.kind === 'unchanged') return unchanged(current);
  if (input.kind === 'connectionEnded') {
    return finishForConnection(current, input.losingSeatIndex, input.committedAt);
  }

  const timeout = applyTurnExpiryDecision(current.match, input.expiry, input.nextTurn);
  if (!timeout.ok || !timeout.changed) return unchanged(current);
  if (timeout.match.status === 'finished') {
    return finishState(current, timeout.match, input.committedAt);
  }
  if (input.connectionAfterTimeout !== null) {
    const connectionEnd = endMatchForConnection(timeout.match, {
      disconnectedSeatIndex: input.connectionAfterTimeout,
    });
    if (connectionEnd.ok && connectionEnd.match.status === 'finished') {
      return finishState(current, connectionEnd.match, input.committedAt);
    }
  }
  return { changed: true, state: { room: current.room, match: timeout.match } };
}

function finishForConnection(
  current: PlayingRoomState,
  losingSeatIndex: SeatIndex,
  committedAt: number,
): DeadlineReconciliation {
  const transition = endMatchForConnection(current.match, {
    disconnectedSeatIndex: losingSeatIndex,
  });
  if (!transition.ok || transition.match.status !== 'finished') return unchanged(current);
  return finishState(current, transition.match, committedAt);
}

function finishState(
  current: PlayingRoomState,
  match: FinishedRoomState['match'],
  committedAt: number,
): DeadlineReconciliation {
  const finished = finishRoomMatch(current, match, committedAt);
  return finished.ok ? { changed: true, state: finished.state } : unchanged(current);
}

function unchanged(current: PlayingRoomState): DeadlineReconciliation {
  return { changed: false, state: { room: current.room, match: current.match } };
}
