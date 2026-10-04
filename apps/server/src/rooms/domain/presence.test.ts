import type { SeatIndex } from '@repo/yacht-rules';
import { describe, expect, it } from 'bun:test';

import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { disconnectSeat, resumeSeat } from '@/rooms/domain/presence';
import { PRESENCE_STATUS, ROOM_REJECTION_CODE, ROOM_STATUS } from '@/rooms/domain/room-constants';
import {
  type PlayingRoom,
  roomId,
  type RoomTransition,
  type WaitingRoom,
} from '@/rooms/domain/room-model';

const creatorIndex = 0 as const;
const joinerIndex = 1 as const;

function waitingRoom(): WaitingRoom {
  const result = createRoom({
    roomId: roomId('room-1'),
    code: '012345',
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!result.ok) throw new Error('fixture creation failed');
  return result.room;
}

function playingRoom(): PlayingRoom {
  const result = joinRoom(waitingRoom(), {
    characterId: 'blonde-buns',
    variant: false,
    joinedAt: 2_000,
  });
  if (!result.ok || !result.changed) throw new Error('fixture join failed');
  return result.room;
}

function connectedPlayingRoom(): PlayingRoom {
  const creatorConnected = resumeSeat(playingRoom(), {
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

describe('room presence', () => {
  it('connects a waiting creator without changing the fixed expiry', () => {
    const room = waitingRoom();
    const connected = resumeSeat(room, { seatIndex: creatorIndex, resumedAt: 2_000 });

    expect(connected.ok).toBe(true);
    expect(connected.changed).toBe(true);
    expect(connected.room).toMatchObject({
      status: ROOM_STATUS.WAITING,
      expiresAt: room.expiresAt,
      seats: [
        {
          presence: { status: PRESENCE_STATUS.CONNECTED },
        },
      ],
    });
    expect(room.seats[0].presence.status).toBe(PRESENCE_STATUS.DISCONNECTED);
  });

  it('treats an already-connected seat as the same-room no-op', () => {
    const first = resumeSeat(waitingRoom(), { seatIndex: creatorIndex, resumedAt: 2_000 });
    if (!first.ok || !first.changed) throw new Error('fixture connection failed');
    const second = resumeSeat(first.room, { seatIndex: creatorIndex, resumedAt: 3_000 });

    expect(second).toEqual({
      ok: true,
      changed: false,
      room: first.room,
    });
    expect(second.room).toBe(first.room);
  });

  it('disconnects a waiting creator without reconnect grace or cleanup', () => {
    const connected = resumeSeat(waitingRoom(), { seatIndex: creatorIndex, resumedAt: 2_000 });
    if (!connected.ok || !connected.changed) throw new Error('fixture connection failed');

    const disconnected = disconnectSeat(connected.room, {
      seatIndex: creatorIndex,
      detectedAt: 3_000,
    });

    expect(disconnected.room).toMatchObject({
      status: ROOM_STATUS.WAITING,
      expiresAt: connected.room.expiresAt,
      seats: [
        {
          presence: {
            status: PRESENCE_STATUS.DISCONNECTED,
            reconnectDeadlineAt: null,
          },
        },
      ],
    });
  });

  it.each([
    [creatorIndex, 0],
    [joinerIndex, 1],
  ] as const)('keeps playing and gives disconnected %s a fixed deadline', (id, index) => {
    const room = connectedPlayingRoom();
    const result = disconnectSeat(room, { seatIndex: id, detectedAt: 3_000 });

    expect(result.room.status).toBe(ROOM_STATUS.PLAYING);
    const { presence } = result.room.seats[index];
    expect(presence.status).toBe(PRESENCE_STATUS.DISCONNECTED);
    if (presence.status !== PRESENCE_STATUS.DISCONNECTED) {
      throw new Error('seat stayed connected');
    }
    expect(Number(presence.reconnectDeadlineAt)).toBe(93_000);
  });

  it('keeps both disconnected seats playing with their original deadlines', () => {
    const first = disconnectSeat(connectedPlayingRoom(), {
      seatIndex: creatorIndex,
      detectedAt: 3_000,
    });
    if (!first.ok || !first.changed || first.room.status !== ROOM_STATUS.PLAYING) {
      throw new Error('first disconnect failed');
    }

    const second = disconnectSeat(first.room, { seatIndex: joinerIndex, detectedAt: 4_000 });

    expect(second.room).toMatchObject({
      status: ROOM_STATUS.PLAYING,
      seats: [
        {
          presence: { reconnectDeadlineAt: 93_000 },
        },
        {
          presence: { reconnectDeadlineAt: 94_000 },
        },
      ],
    });
  });

  it('resumes during grace without extending the other seat deadline', () => {
    const first = disconnectSeat(connectedPlayingRoom(), {
      seatIndex: creatorIndex,
      detectedAt: 3_000,
    });
    if (!first.ok || !first.changed || first.room.status !== ROOM_STATUS.PLAYING) {
      throw new Error('first disconnect failed');
    }
    const second = disconnectSeat(first.room, { seatIndex: joinerIndex, detectedAt: 4_000 });
    if (!second.ok || !second.changed) throw new Error('second disconnect failed');

    const resumed = resumeSeat(second.room, { seatIndex: creatorIndex, resumedAt: 88_000 });

    expect(resumed.room).toMatchObject({
      status: ROOM_STATUS.PLAYING,
      seats: [
        { presence: { status: PRESENCE_STATUS.CONNECTED } },
        {
          presence: {
            status: PRESENCE_STATUS.DISCONNECTED,
            reconnectDeadlineAt: 94_000,
          },
        },
      ],
    });
  });

  it('allows playing resume before but not at the fixed deadline', () => {
    const disconnected = disconnectSeat(connectedPlayingRoom(), {
      seatIndex: creatorIndex,
      detectedAt: 3_000,
    });
    if (!disconnected.ok || !disconnected.changed) throw new Error('fixture disconnect failed');

    const before = resumeSeat(disconnected.room, { seatIndex: creatorIndex, resumedAt: 92_999 });
    expect(before.ok).toBe(true);
    expect(before.changed).toBe(true);

    expect(resumeSeat(disconnected.room, { seatIndex: creatorIndex, resumedAt: 93_000 })).toEqual({
      ok: false,
      changed: false,
      room: disconnected.room,
      code: ROOM_REJECTION_CODE.RECONNECT_NOT_AVAILABLE,
    });
  });

  it.each([93_000, 93_001])(
    'rejects either seat when the earliest deadline expired at %d',
    (resumedAt) => {
      const first = disconnectSeat(connectedPlayingRoom(), {
        seatIndex: creatorIndex,
        detectedAt: 3_000,
      });
      if (!first.ok) throw new Error('fixture disconnect failed');
      const second = disconnectSeat(first.room, { seatIndex: joinerIndex, detectedAt: 63_000 });
      if (!second.ok) throw new Error('fixture disconnect failed');
      expect(resumeSeat(second.room, { seatIndex: joinerIndex, resumedAt })).toMatchObject({
        ok: false,
        code: ROOM_REJECTION_CODE.RECONNECT_NOT_AVAILABLE,
      });
    },
  );

  it('does not extend a repeated disconnect or invent a deadline for an unconnected seat', () => {
    const initial = playingRoom();
    expect(disconnectSeat(initial, { seatIndex: joinerIndex, detectedAt: 3_000 })).toMatchObject({
      changed: false,
    });
    expect(initial.seats[1].presence).toEqual({
      status: PRESENCE_STATUS.DISCONNECTED,
      reconnectDeadlineAt: null,
    });
    const first = disconnectSeat(connectedPlayingRoom(), {
      seatIndex: creatorIndex,
      detectedAt: 3_000,
    });
    if (!first.ok) throw new Error('fixture disconnect failed');
    const repeated = disconnectSeat(first.room, { seatIndex: creatorIndex, detectedAt: 63_000 });
    expect(repeated).toMatchObject({ ok: true, changed: false });
    expect(repeated.room).toBe(first.room);
  });

  it('rejects a disconnect timestamp whose fixed deadline would overflow', () => {
    const room = connectedPlayingRoom();

    expect(
      disconnectSeat(room, {
        seatIndex: creatorIndex,
        detectedAt: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({
      ok: false,
      changed: false,
      room,
      code: ROOM_REJECTION_CODE.INVALID_TIMESTAMP,
    });
  });

  it('rejects presence timestamps before room creation', () => {
    const disconnected = disconnectSeat(connectedPlayingRoom(), {
      seatIndex: creatorIndex,
      detectedAt: 3_000,
    });
    if (!disconnected.ok || !disconnected.changed) throw new Error('fixture disconnect failed');

    const transitions = [
      disconnectSeat(connectedPlayingRoom(), { seatIndex: creatorIndex, detectedAt: 999 }),
      resumeSeat(disconnected.room, { seatIndex: creatorIndex, resumedAt: 999 }),
    ];

    for (const transition of transitions) {
      expect(transition).toMatchObject({
        ok: false,
        changed: false,
        code: ROOM_REJECTION_CODE.INVALID_TIMESTAMP,
      });
    }
  });

  it.each([
    {
      name: 'disconnect',
      apply: (room: PlayingRoom): RoomTransition =>
        disconnectSeat(room, { seatIndex: 2 as SeatIndex, detectedAt: 3_000 }),
    },
    {
      name: 'resume',
      apply: (room: PlayingRoom): RoomTransition =>
        resumeSeat(room, { seatIndex: 2 as SeatIndex, resumedAt: 3_000 }),
    },
  ])('rejects an unknown seat on $name without changing the room', ({ apply }) => {
    const room = playingRoom();

    expect(apply(room)).toEqual({
      ok: false,
      changed: false,
      room,
      code: ROOM_REJECTION_CODE.SEAT_NOT_FOUND,
    });
  });
});
