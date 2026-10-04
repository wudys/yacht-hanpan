import type { ActionLedgerEntry } from '@/rooms/commands/action-ledger';
import type { SeatTokenHash } from '@/rooms/connections/seat-token';
import { ROOM_STATUS } from '@/rooms/domain/room-constants';
import type { RoomTransition } from '@/rooms/domain/room-model';
import {
  type FinishedRoomState,
  isPlayingRoomState,
  isWaitingRoomState,
  type PlayingRoomState,
  type WaitingRoomState,
} from '@/rooms/domain/room-state';

interface RecordMetadata {
  readonly actionLedger: readonly ActionLedgerEntry[];
  readonly stateVersion: number;
  readonly presenceVersion: number;
}

export type WaitingRoomRecord = WaitingRoomState &
  RecordMetadata & {
    readonly credentialHashes: readonly [SeatTokenHash];
  };

export type PlayingRoomRecord = PlayingRoomState &
  RecordMetadata & {
    readonly credentialHashes: readonly [SeatTokenHash, SeatTokenHash];
  };

export type FinishedRoomRecord = FinishedRoomState &
  RecordMetadata & {
    readonly credentialHashes: readonly [SeatTokenHash, SeatTokenHash];
  };

export type RoomRecord = WaitingRoomRecord | PlayingRoomRecord | FinishedRoomRecord;

export function applyPresenceToRoomRecord(
  current: RoomRecord,
  transition: Extract<RoomTransition, { readonly ok: true }>,
): RoomRecord | null {
  if (!transition.changed) return current;
  const { room } = transition;
  if (isWaitingRoomState(current) && room.status === ROOM_STATUS.WAITING) {
    return { ...current, room, presenceVersion: current.presenceVersion + 1 };
  }
  if (isPlayingRoomState(current) && room.status === ROOM_STATUS.PLAYING) {
    return { ...current, room, presenceVersion: current.presenceVersion + 1 };
  }
  return null;
}
