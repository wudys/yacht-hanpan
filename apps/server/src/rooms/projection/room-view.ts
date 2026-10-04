import { type GameSnapshot, parseRoomView, type RoomView } from '@repo/game-protocol/socket';

import { projectGameSnapshot } from '@/rooms/projection/match';
import { projectPresenceSnapshot } from '@/rooms/projection/presence';
import { projectPublicRoom } from '@/rooms/projection/room';
import type { FinishedRoomRecord, PlayingRoomRecord, RoomRecord } from '@/rooms/record';

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
