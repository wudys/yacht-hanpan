import type { CharacterId } from '@repo/game-assets/characters';

import type {
  PRESENCE_STATUS,
  ROOM_REJECTION_CODE,
  ROOM_STATUS,
} from '@/rooms/domain/room-constants';
import type { EpochMilliseconds } from '@/rooms/domain/time';

type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type RoomId = Brand<string, 'RoomId'>;
export type RoomCode = Brand<string, 'RoomCode'>;

export interface SeatProfile {
  readonly characterId: CharacterId;
  readonly variant: boolean;
}

export interface ConnectedPresence {
  readonly status: typeof PRESENCE_STATUS.CONNECTED;
}

export interface DisconnectedPresence {
  readonly status: typeof PRESENCE_STATUS.DISCONNECTED;
  readonly reconnectDeadlineAt: EpochMilliseconds | null;
}

export type SeatPresence = ConnectedPresence | DisconnectedPresence;

export interface Seat {
  readonly profile: SeatProfile;
  readonly presence: SeatPresence;
}

export type PlayingSeats = readonly [Seat, Seat];

interface RoomIdentity {
  readonly id: RoomId;
  readonly code: RoomCode;
  readonly createdAt: EpochMilliseconds;
}

export type WaitingRoom = RoomIdentity & {
  readonly status: typeof ROOM_STATUS.WAITING;
  readonly expiresAt: EpochMilliseconds;
  readonly seats: readonly [Seat];
};

export type PlayingRoom = RoomIdentity & {
  readonly status: typeof ROOM_STATUS.PLAYING;
  readonly startedAt: EpochMilliseconds;
  readonly seats: PlayingSeats;
};

export type FinishedRoom = RoomIdentity & {
  readonly status: typeof ROOM_STATUS.FINISHED;
  readonly startedAt: EpochMilliseconds;
  readonly finishedAt: EpochMilliseconds;
  readonly seats: PlayingSeats;
};

export type Room = WaitingRoom | PlayingRoom | FinishedRoom;

export type RoomCreationResult =
  | { readonly ok: true; readonly room: WaitingRoom }
  | {
      readonly ok: false;
      readonly code: (typeof ROOM_REJECTION_CODE)[keyof typeof ROOM_REJECTION_CODE];
    };

export type RoomTransition<Next extends Room = Room, Previous extends Room = Room> =
  | { readonly ok: true; readonly changed: true; readonly room: Next }
  | { readonly ok: true; readonly changed: false; readonly room: Previous }
  | {
      readonly ok: false;
      readonly changed: false;
      readonly room: Previous;
      readonly code: (typeof ROOM_REJECTION_CODE)[keyof typeof ROOM_REJECTION_CODE];
    };

export function roomId(value: string): RoomId {
  if (value.length === 0) throw new Error('RoomId must not be empty');
  return value as RoomId;
}
