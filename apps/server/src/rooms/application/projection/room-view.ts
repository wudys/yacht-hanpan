import { type GameSnapshot, parseRoomView, type RoomView } from '@repo/game-protocol/socket';

import { projectGameSnapshot } from '@/rooms/application/projection/game-snapshot';
import { projectPresenceSnapshot } from '@/rooms/application/projection/presence-snapshot';
import { projectPublicRoom } from '@/rooms/application/projection/public-room';
import type {
  FinishedRoomRecord,
  PlayingRoomRecord,
  RoomRecord,
} from '@/rooms/application/room-record';

export function projectRoomView(
  record: PlayingRoomRecord | FinishedRoomRecord,
): RoomView & Readonly<{ game: GameSnapshot }>;
export function projectRoomView(record: RoomRecord): RoomView;
export function projectRoomView(record: RoomRecord): RoomView {
  return parseRoomView({
    room: projectPublicRoom(record.room),
    game: record.match === null ? null : projectGameSnapshot(record.match, record.stateVersion),
    presence: projectPresenceSnapshot(record.room, record.presenceVersion),
  });
}
