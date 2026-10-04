import type { FinishedMatch, PlayingMatch } from '@/rooms/domain/match/model';
import { ROOM_STATUS } from '@/rooms/domain/room-constants';
import type { FinishedRoom, PlayingRoom, WaitingRoom } from '@/rooms/domain/room-model';

export interface WaitingRoomState {
  readonly room: WaitingRoom;
  readonly match: null;
}

export interface PlayingRoomState {
  readonly room: PlayingRoom;
  readonly match: PlayingMatch;
}

export interface FinishedRoomState {
  readonly room: FinishedRoom;
  readonly match: FinishedMatch;
}

export type RoomState = WaitingRoomState | PlayingRoomState | FinishedRoomState;

export function isWaitingRoomState<State extends RoomState>(
  state: State,
): state is Extract<State, WaitingRoomState> {
  return state.room.status === ROOM_STATUS.WAITING;
}

export function isPlayingRoomState<State extends RoomState>(
  state: State,
): state is Extract<State, PlayingRoomState> {
  return state.room.status === ROOM_STATUS.PLAYING;
}

export function isFinishedRoomState<State extends RoomState>(
  state: State,
): state is Extract<State, FinishedRoomState> {
  return state.room.status === ROOM_STATUS.FINISHED;
}
