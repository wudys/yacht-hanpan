import { describe, expect, it } from 'bun:test';

import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { disconnectSeat, resumeSeat } from '@/rooms/domain/presence';
import { earliestReconnectDeadline } from '@/rooms/domain/reconnect-policy';
import { ROOM_STATUS } from '@/rooms/domain/room-constants';
import { type PlayingRoom, roomId } from '@/rooms/domain/room-model';

const creatorIndex = 0 as const;
const joinerIndex = 1 as const;

function connectedPlayingRoom(): PlayingRoom {
  const created = createRoom({
    roomId: roomId('room-1'),
    code: '012345',
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!created.ok) throw new Error('fixture creation failed');
  const joined = joinRoom(created.room, {
    characterId: 'blonde-buns',
    variant: false,
    joinedAt: 2_000,
  });
  if (!joined.ok) throw new Error('fixture join failed');
  const creatorConnected = resumeSeat(joined.room, {
    seatIndex: creatorIndex,
    resumedAt: 2_100,
  });
  if (!creatorConnected.ok || !creatorConnected.changed) {
    throw new Error('creator connection failed');
  }
  const joinerConnected = resumeSeat(creatorConnected.room, {
    seatIndex: joinerIndex,
    resumedAt: 2_200,
  });
  if (!joinerConnected.ok || !joinerConnected.changed) {
    throw new Error('joiner connection failed');
  }
  return joinerConnected.room;
}

function creatorDisconnectedRoom(): PlayingRoom {
  const result = disconnectSeat(connectedPlayingRoom(), {
    seatIndex: creatorIndex,
    detectedAt: 3_000,
  });
  if (!result.ok || !result.changed || result.room.status !== ROOM_STATUS.PLAYING) {
    throw new Error('fixture disconnect failed');
  }
  return result.room;
}

function bothDisconnectedRoom(): PlayingRoom {
  const creatorDisconnected = creatorDisconnectedRoom();
  const result = disconnectSeat(creatorDisconnected, {
    seatIndex: joinerIndex,
    detectedAt: 4_000,
  });
  if (!result.ok || !result.changed || result.room.status !== ROOM_STATUS.PLAYING) {
    throw new Error('fixture disconnect transition failed');
  }
  return result.room;
}

describe('earliestReconnectDeadline', () => {
  it('uses the original deadline and ignores a connected seat', () => {
    expect(earliestReconnectDeadline(creatorDisconnectedRoom())).toEqual({
      seatIndex: creatorIndex,
      reconnectDeadlineAt: 93_000,
    });
    expect(earliestReconnectDeadline(connectedPlayingRoom())).toBeNull();
  });

  it('does not invent a deadline for a seat that has never connected', () => {
    const room = connectedPlayingRoom();
    const initial: PlayingRoom = {
      ...room,
      seats: [
        room.seats[0],
        { ...room.seats[1], presence: { status: 'disconnected', reconnectDeadlineAt: null } },
      ],
    };
    expect(earliestReconnectDeadline(initial)).toBeNull();
  });

  it('selects the earlier time rather than the first seat in the tuple', () => {
    const room = bothDisconnectedRoom();
    const reversed: PlayingRoom = { ...room, seats: [room.seats[1], room.seats[0]] };
    expect(earliestReconnectDeadline(reversed)).toEqual({
      seatIndex: joinerIndex,
      reconnectDeadlineAt: 93_000,
    });
  });

  it('removes only the returning seat deadline without extending the absent peer', () => {
    const room = bothDisconnectedRoom();
    const resumed = resumeSeat(room, { seatIndex: creatorIndex, resumedAt: 88_000 });
    if (!resumed.ok) throw new Error('fixture resume failed');
    expect(earliestReconnectDeadline(resumed.room)).toEqual({
      seatIndex: joinerIndex,
      reconnectDeadlineAt: 94_000,
    });
    expect(earliestReconnectDeadline(room)).toEqual({
      seatIndex: creatorIndex,
      reconnectDeadlineAt: 93_000,
    });
  });
});
