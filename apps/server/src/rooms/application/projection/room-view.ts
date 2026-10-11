import { type GameSnapshot, parseRoomView, type RoomView } from '@repo/game-protocol/state';

import { projectGameSnapshotInput } from '@/rooms/application/projection/game-snapshot';
import { projectPresenceSnapshotInput } from '@/rooms/application/projection/presence-snapshot';
import { projectPublicRoomInput } from '@/rooms/application/projection/public-room';
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
    room: projectPublicRoomInput(record.room),
    game:
      record.match === null ? null : projectGameSnapshotInput(record.match, record.stateVersion),
    presence: projectPresenceSnapshotInput(record.room, record.presenceVersion),
  });
}
