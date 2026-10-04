import { describe, expect, it } from 'bun:test';

import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { disconnectSeat, resumeSeat } from '@/rooms/domain/presence';
import { PRESENCE_STATUS, ROOM_STATUS } from '@/rooms/domain/room-constants';
import { assertRoomInvariant } from '@/rooms/domain/room-invariants';
import { markGameFinished } from '@/rooms/domain/room-lifecycle';
import { type Room, roomId } from '@/rooms/domain/room-model';

const creatorIndex = 0 as const;
const joinerIndex = 1 as const;

function roomSequence(): Room[] {
  const created = createRoom({
    roomId: roomId('room-1'),
    code: '012345',
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!created.ok) throw new Error('fixture creation failed');
  const joined = joinRoom(created.room, {
    characterId: 'navy-bob',
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
  const creatorDisconnected = disconnectSeat(joinerConnected.room, {
    seatIndex: creatorIndex,
    detectedAt: 3_000,
  });
  if (!creatorDisconnected.ok || !creatorDisconnected.changed) {
    throw new Error('creator disconnect failed');
  }
  const bothDisconnected = disconnectSeat(creatorDisconnected.room, {
    seatIndex: joinerIndex,
    detectedAt: 4_000,
  });
  if (!bothDisconnected.ok || !bothDisconnected.changed) {
    throw new Error('joiner disconnect failed');
  }
  const finished = markGameFinished(joined.room, { finishedAt: 10_000 });
  if (!finished.ok || !finished.changed) throw new Error('fixture finish failed');

  return [
    created.room,
    joined.room,
    creatorConnected.room,
    joinerConnected.room,
    creatorDisconnected.room,
    bothDisconnected.room,
    finished.room,
  ];
}

describe('assertRoomInvariant', () => {
  it('accepts every reachable lifecycle branch', () => {
    for (const room of roomSequence()) {
      expect(() => assertRoomInvariant(room)).not.toThrow();
    }
  });

  it('rejects malformed code and profile character', () => {
    const playing = roomSequence().find((room) => room.status === ROOM_STATUS.PLAYING);
    if (playing?.status !== ROOM_STATUS.PLAYING) throw new Error('playing fixture missing');

    const badCode = structuredClone(playing);
    Object.defineProperty(badCode, 'code', { value: 'bad-code' });
    expect(() => assertRoomInvariant(badCode)).toThrow('room code');

    const badCharacter = structuredClone(playing);
    Object.defineProperty(badCharacter.seats[1].profile, 'characterId', { value: 'unknown' });
    expect(() => assertRoomInvariant(badCharacter)).toThrow('profile character');
  });

  it('rejects a waiting expiry that changes the fixed lifetime', () => {
    const rooms = roomSequence();
    const waiting = rooms.find((room) => room.status === ROOM_STATUS.WAITING);
    if (waiting?.status !== ROOM_STATUS.WAITING) throw new Error('fixture missing');

    const badExpiry = structuredClone(waiting);
    Object.defineProperty(badExpiry, 'expiresAt', { value: waiting.expiresAt + 1 });
    expect(() => assertRoomInvariant(badExpiry)).toThrow('waiting expiry');
  });

  it('keeps playing regardless of which role disconnects first', () => {
    const playing = roomSequence().find(
      (room) =>
        room.status === ROOM_STATUS.PLAYING &&
        room.seats.every((seat) => seat.presence.status === PRESENCE_STATUS.CONNECTED),
    );
    if (playing?.status !== ROOM_STATUS.PLAYING) throw new Error('connected fixture missing');

    for (const [first, second] of [
      [creatorIndex, joinerIndex],
      [joinerIndex, creatorIndex],
    ] as const) {
      const firstResult = disconnectSeat(playing, { seatIndex: first, detectedAt: 3_000 });
      if (!firstResult.ok || !firstResult.changed) throw new Error('first disconnect failed');
      const secondResult = disconnectSeat(firstResult.room, {
        seatIndex: second,
        detectedAt: 4_000,
      });
      if (!secondResult.ok || !secondResult.changed) throw new Error('second disconnect failed');

      expect(secondResult.room).toMatchObject({
        status: ROOM_STATUS.PLAYING,
      });
      expect(() => assertRoomInvariant(secondResult.room)).not.toThrow();
    }
  });

  it('keeps credential, transport, match, and wire state out of every branch', () => {
    const serialized = JSON.stringify(roomSequence());

    for (const forbidden of [
      'seatToken',
      'tokenHash',
      'socketId',
      'clientId',
      'match',
      'stateVersion',
      'presenceVersion',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
