import { describe, expect, test } from 'bun:test';

import { seatTokenHash } from '@/rooms/connections/seat-token';
import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { createMatch, turnId } from '@/rooms/domain/match';
import { roomId } from '@/rooms/domain/room-model';
import { epochMilliseconds } from '@/rooms/domain/time';
import type { RoomRecord, WaitingRoomRecord } from '@/rooms/record';
import { InMemoryRoomRepository } from '@/rooms/repository';

const ROOM_ID = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39843e');
const CREATOR_SEAT_INDEX = 0 as const;

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

describe('memory room repository', () => {
  test('atomically inserts a waiting record and all indexes', () => {
    const repository = new InMemoryRoomRepository();
    const record: WaitingRoomRecord = {
      ...createWaitingRecord(),
      actionLedger: [
        {
          status: 'retryable',
          seatIndex: CREATOR_SEAT_INDEX,
          actionId: 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
          fingerprint: 'f'.repeat(64),
        },
      ],
    };

    expect(repository.createExclusive(record)).toEqual({ ok: true });
    expect(repository.getById(ROOM_ID)).toBe(record);
    expect(repository.findRoomIdByCode(record.room.code)).toBe(ROOM_ID);
    expect(repository.counts()).toEqual({ rooms: 1, codes: 1 });
    expect(repository.telemetryCounts()).toEqual({
      rooms: 1,
      codes: 1,
      actionLedgerEntries: 1,
    });
  });

  test('rejects code and room ID conflicts without partial indexes', () => {
    const repository = new InMemoryRoomRepository();
    const first = createWaitingRecord();
    expect(repository.createExclusive(first)).toEqual({ ok: true });

    const codeConflict = {
      ...createWaitingRecord(first.room.code),
      room: {
        ...createWaitingRecord(first.room.code).room,
        id: roomId('018f47f2-c2d8-7f4a-8bf4-3f559c398442'),
      },
    } as RoomRecord;
    expect(repository.createExclusive(codeConflict)).toEqual({ ok: false, reason: 'codeConflict' });

    const roomIdConflict = {
      ...createWaitingRecord('001205'),
      room: {
        ...createWaitingRecord('001205').room,
        id: ROOM_ID,
      },
    } as RoomRecord;
    expect(repository.createExclusive(roomIdConflict)).toEqual({
      ok: false,
      reason: 'roomIdConflict',
    });
    expect(repository.counts()).toEqual({ rooms: 1, codes: 1 });
  });

  test('reserves code on join until deletion', () => {
    const repository = new InMemoryRoomRepository();
    const waiting = createWaitingRecord();
    const playing = createPlayingRecord(waiting);
    repository.createExclusive(waiting);

    expect(repository.replace(ROOM_ID, playing)).toBeTrue();
    expect(repository.findRoomIdByCode(waiting.room.code)).toBe(ROOM_ID);
    expect(repository.remove(ROOM_ID)).toBe(playing);
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });
    expect(repository.telemetryCounts()).toEqual({
      rooms: 0,
      codes: 0,
      actionLedgerEntries: 0,
    });
  });

  test('refuses replacement with a different identity or code', () => {
    const repository = new InMemoryRoomRepository();
    const waiting = createWaitingRecord();
    repository.createExclusive(waiting);
    const invalid = {
      ...waiting,
      room: { ...waiting.room, code: '999999' },
    } as RoomRecord;

    expect(() => repository.replace(ROOM_ID, invalid)).toThrow();
    expect(repository.getById(ROOM_ID)).toBe(waiting);
  });

  test('rejects invalid room state before mutating storage or indexes', () => {
    const repository = new InMemoryRoomRepository();
    const waiting = createWaitingRecord();
    const invalid = {
      ...waiting,
      room: { ...waiting.room, expiresAt: waiting.room.expiresAt + 1 },
    } as RoomRecord;

    expect(() => repository.createExclusive(invalid)).toThrow('Room invariant violated');
    expect(repository.counts()).toEqual({ rooms: 0, codes: 0 });

    expect(repository.createExclusive(waiting)).toEqual({ ok: true });
    expect(() => repository.replace(ROOM_ID, invalid)).toThrow('Room invariant violated');
    expect(repository.getById(ROOM_ID)).toBe(waiting);
  });
});
