import { describe, expect, test } from 'bun:test';

import { seatTokenHash } from '@/rooms/application/connections/seat-token';
import {
  applyPresenceToRoomRecord,
  type RoomRecord,
  type WaitingRoomRecord,
} from '@/rooms/application/room-record';
import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { createMatch, turnId } from '@/rooms/domain/match';
import { disconnectSeat, resumeSeat } from '@/rooms/domain/presence';
import { roomId } from '@/rooms/domain/room-model';
import { epochMilliseconds } from '@/rooms/domain/time';

const ROOM_ID = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39843e');

function createWaitingRecord(code: string = '001204'): WaitingRoomRecord {
  const result = createRoom({
    roomId: ROOM_ID,
    code,
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!result.ok) throw new Error('fixture room creation failed');
  return {
    actionLedger: [],
    room: result.room,
    match: null,
    credentialHashes: [seatTokenHash('a'.repeat(64))],
    stateVersion: 0,
    presenceVersion: 0,
  };
}

function createPlayingRecord(waiting: WaitingRoomRecord = createWaitingRecord()): RoomRecord {
  const joined = joinRoom(waiting.room, {
    characterId: 'blonde-buns',
    variant: false,
    joinedAt: 2_000,
  });
  if (!joined.ok) throw new Error('fixture join failed');
  const match = createMatch({
    initialTurn: {
      id: turnId('018f47f2-c2d8-7f4a-8bf4-3f559c398441'),
      startedAt: epochMilliseconds(2_000),
    },
  });
  return {
    ...waiting,
    room: joined.room,
    match,
    credentialHashes: [waiting.credentialHashes[0], seatTokenHash('b'.repeat(64))],
  };
}

describe('room record presence transitions', () => {
  test('preserves waiting metadata and keeps unchanged transitions referentially stable', () => {
    const current = createWaitingRecord();
    const connected = resumeSeat(current.room, { seatIndex: 0, resumedAt: 2_000 });
    if (!connected.ok || connected.room.status !== 'waiting') throw new Error('connect failed');
    const next = applyPresenceToRoomRecord(current, connected);
    expect(next).toEqual({ ...current, room: connected.room, presenceVersion: 1 });
    if (next === null) throw new Error('record transition failed');
    const repeated = resumeSeat(next.room, { seatIndex: 0, resumedAt: 2_100 });
    if (!repeated.ok) throw new Error('repeated connect failed');
    expect(applyPresenceToRoomRecord(next, repeated)).toBe(next);
  });

  test('preserves match, ledger and credentials through both disconnects and resume', () => {
    const initial = createPlayingRecord();
    let current = initial;
    const transitions = [
      (record: RoomRecord) => resumeSeat(record.room, { seatIndex: 0, resumedAt: 3_000 }),
      (record: RoomRecord) => resumeSeat(record.room, { seatIndex: 1, resumedAt: 3_100 }),
      (record: RoomRecord) => disconnectSeat(record.room, { seatIndex: 0, detectedAt: 4_000 }),
      (record: RoomRecord) => disconnectSeat(record.room, { seatIndex: 1, detectedAt: 4_100 }),
      (record: RoomRecord) => resumeSeat(record.room, { seatIndex: 0, resumedAt: 5_000 }),
    ];
    const statuses: string[] = [];
    for (const transition of transitions) {
      const changed = transition(current);
      if (!changed.ok || !changed.changed) throw new Error('presence transition failed');
      const next = applyPresenceToRoomRecord(current, changed);
      if (next === null) throw new Error('record transition failed');
      expect(next.match).toBe(initial.match);
      expect(next.actionLedger).toBe(initial.actionLedger);
      expect(next.credentialHashes).toBe(initial.credentialHashes);
      expect(next.stateVersion).toBe(initial.stateVersion);
      expect(next.presenceVersion).toBe(current.presenceVersion + 1);
      statuses.push(next.room.status);
      current = next;
    }
    expect(statuses).toEqual(['playing', 'playing', 'playing', 'playing', 'playing']);
    expect(current.room.seats[1]?.presence).toMatchObject({
      status: 'disconnected',
      reconnectDeadlineAt: 94_100,
    });
  });
});
