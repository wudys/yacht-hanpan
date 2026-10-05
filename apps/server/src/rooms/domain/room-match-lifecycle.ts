import type { FinishedMatch, NextTurnInput } from '@/rooms/domain/match/model';
import { createMatch } from '@/rooms/domain/match/state';
import {
  ROOM_REJECTION_CODE,
  ROOM_STATUS,
  type RoomRejectionCode,
} from '@/rooms/domain/room-constants';
import type { FinishedRoom, PlayingRoom, Room, RoomTransition } from '@/rooms/domain/room-model';
import type { FinishedRoomState, PlayingRoomState } from '@/rooms/domain/room-state';
import { roomRejected, roomUnchanged } from '@/rooms/domain/room-transition-result';
import { epochMilliseconds, isValidTimestamp } from '@/rooms/domain/time';

export interface MarkGameFinishedInput {
  readonly finishedAt: unknown;
}

export function startRoomMatch(room: PlayingRoom, initialTurn: NextTurnInput): PlayingRoomState {
  return { room, match: createMatch({ initialTurn }) };
}

export type FinishRoomMatchResult =
  | { readonly ok: true; readonly state: FinishedRoomState }
  | { readonly ok: false; readonly reason: 'roomRejected'; readonly code: RoomRejectionCode };

export function finishRoomMatch(
  current: PlayingRoomState,
  match: FinishedMatch,
  committedAt: number,
): FinishRoomMatchResult {
  const finished = markGameFinished(current.room, { finishedAt: committedAt });
  if (!finished.ok) return { ok: false, reason: 'roomRejected', code: finished.code };
  return { ok: true, state: { room: finished.room, match } };
}

export function markGameFinished(
  room: PlayingRoom,
  input: MarkGameFinishedInput,
): Exclude<
  RoomTransition<FinishedRoom, PlayingRoom>,
  { readonly ok: true; readonly changed: false }
>;
export function markGameFinished(
  room: Room,
  input: MarkGameFinishedInput,
): RoomTransition<FinishedRoom, Room>;
export function markGameFinished(
  room: Room,
  input: MarkGameFinishedInput,
): RoomTransition<FinishedRoom, Room> {
  if (!isValidTimestamp(input.finishedAt)) {
    return roomRejected(room, ROOM_REJECTION_CODE.INVALID_TIMESTAMP);
  }
  if (room.status === ROOM_STATUS.FINISHED) return roomUnchanged(room);
  if (room.status === ROOM_STATUS.WAITING) {
    return roomRejected(room, ROOM_REJECTION_CODE.ROOM_NOT_PLAYING);
  }
  if (input.finishedAt < room.startedAt) {
    return roomRejected(room, ROOM_REJECTION_CODE.INVALID_TIMESTAMP);
  }

  return {
    ok: true,
    changed: true,
    room: {
      id: room.id,
      code: room.code,
      status: ROOM_STATUS.FINISHED,
      createdAt: room.createdAt,
      startedAt: room.startedAt,
      finishedAt: epochMilliseconds(input.finishedAt),
      seats: room.seats,
    },
  };
}
