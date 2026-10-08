import {
  parseGameSnapshot,
  parsePresenceSnapshot,
  parsePublicRoom,
} from '@repo/game-protocol/socket';
import { describe, expect, test } from 'bun:test';

import { hashSeatToken } from '@/rooms/application/connections/seat-token';
import { projectGameSnapshot } from '@/rooms/application/projection/game-snapshot';
import { projectPresenceSnapshot } from '@/rooms/application/projection/presence-snapshot';
import { projectPublicRoom } from '@/rooms/application/projection/public-room';
import { projectRoomView } from '@/rooms/application/projection/room-view';
import type {
  FinishedRoomRecord,
  PlayingRoomRecord,
  RoomRecord,
  WaitingRoomRecord,
} from '@/rooms/application/room-record';
import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { createMatch, forfeitMatch, turnId } from '@/rooms/domain/match';
import { PRESENCE_STATUS } from '@/rooms/domain/room-constants';
import { markRoomFinished } from '@/rooms/domain/room-match-lifecycle';
import { type PlayingRoom, roomId, type WaitingRoom } from '@/rooms/domain/room-model';
import { epochMilliseconds } from '@/rooms/domain/time';

const ROOM_ID = roomId('018f47f2-c2d8-7f4a-8bf4-3f559c39843e');
const CREATOR_SEAT_INDEX = 0 as const;

function waitingRoom(): WaitingRoom {
  const created = createRoom({
    roomId: ROOM_ID,
    code: '001204',
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!created.ok) throw new Error('fixture create failed');
  return created.room;
}

function playingRoom(): PlayingRoom {
  const joined = joinRoom(waitingRoom(), {
    characterId: 'navy-bob',
    variant: false,
    joinedAt: 2_000,
  });
  if (!joined.ok) throw new Error('fixture join failed');
  return joined.room;
}

function bothDisconnectedRoom(): PlayingRoom {
  const room = playingRoom();
  return {
    ...room,
    seats: [
      {
        ...room.seats[0],
        presence: {
          status: PRESENCE_STATUS.DISCONNECTED,
          reconnectDeadlineAt: epochMilliseconds(94_000),
        },
      },
      {
        ...room.seats[1],
        presence: {
          status: PRESENCE_STATUS.DISCONNECTED,
          reconnectDeadlineAt: epochMilliseconds(94_000),
        },
      },
    ],
  };
}

function waitingRecord(): WaitingRoomRecord {
  return {
    room: waitingRoom(),
    match: null,
    stateVersion: 0,
    presenceVersion: 0,
    credentialHashes: [hashSeatToken('projection-fixture-creator')],
    actionLedger: [],
  };
}

function playingRecord(): PlayingRoomRecord {
  return {
    room: bothDisconnectedRoom(),
    match: createMatch({
      initialTurn: {
        id: turnId('018f47f2-c2d8-7f4a-8bf4-3f559c398441'),
        startedAt: epochMilliseconds(2_000),
      },
    }),
    stateVersion: 11,
    presenceVersion: 7,
    credentialHashes: [
      hashSeatToken('projection-fixture-creator'),
      hashSeatToken('projection-fixture-joiner'),
    ],
    actionLedger: [
      {
        status: 'tombstone',
        seatIndex: 0,
        actionId: 'private-action',
        fingerprint: 'private-payload',
      },
    ],
  };
}

function finishedRecord(): FinishedRoomRecord {
  const current = playingRecord();
  const finishedRoom = markRoomFinished(current.room, { finishedAt: 3_000 });
  const finishedMatch = forfeitMatch(current.match, { forfeitingSeatIndex: 1 });
  if (!finishedRoom.ok || !finishedRoom.changed || !finishedMatch.ok) {
    throw new Error('fixture finish failed');
  }
  if (finishedMatch.match.status !== 'finished') throw new Error('fixture match is not finished');
  return {
    ...current,
    room: finishedRoom.room,
    match: finishedMatch.match,
    stateVersion: 12,
  };
}

describe('server projections', () => {
  test('projects a complete waiting view with initial presence and no game', () => {
    expect(projectRoomView(waitingRecord()) as unknown).toEqual({
      room: {
        status: 'waiting',
        roomId: ROOM_ID,
        roomCode: '001204',
        createdAt: 1_000,
        expiresAt: 301_000,
        seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
      },
      game: null,
      presence: {
        roomId: ROOM_ID,
        presenceVersion: 0,
        seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
      },
    });
  });

  test('projects one playing record with independent versions and unchanged deadlines', () => {
    const record = playingRecord();
    const before = structuredClone(record);
    const view = projectRoomView(record);

    expect(view.room as unknown).toEqual({
      status: 'playing',
      roomId: ROOM_ID,
      roomCode: '001204',
      createdAt: 1_000,
      startedAt: 2_000,
      seats: [
        { profile: { characterId: 'navy-bob', variant: false } },
        { profile: { characterId: 'navy-bob', variant: false } },
      ],
    });
    expect(view.game as unknown).toEqual({
      stateVersion: 11,
      match: {
        status: 'playing',
        players: [
          { scorecard: {}, timeoutCount: 0 },
          { scorecard: {}, timeoutCount: 0 },
        ],
        currentTurn: {
          turnId: '018f47f2-c2d8-7f4a-8bf4-3f559c398441',
          seatIndex: CREATOR_SEAT_INDEX,
          startedAt: 2_000,
          deadlineAt: 92_000,
          heldSlots: [],
          rollCount: 0,
          dice: null,
        },
      },
    });
    expect(view.presence as unknown).toEqual({
      roomId: ROOM_ID,
      presenceVersion: 7,
      seats: [
        { status: 'disconnected', reconnectDeadlineAt: 94_000 },
        { status: 'disconnected', reconnectDeadlineAt: 94_000 },
      ],
    });
    expect(JSON.stringify(view)).not.toMatch(
      /credential|hash|token|actionLedger|private-action|private-payload/i,
    );
    expect(record).toEqual(before);
  });

  test('projects a complete finished view without reviving a turn', () => {
    const view = projectRoomView(finishedRecord());

    expect(view.room).toMatchObject({ status: 'finished', startedAt: 2_000, finishedAt: 3_000 });
    expect(view.game as unknown).toEqual({
      stateVersion: 12,
      match: {
        status: 'finished',
        players: [
          { scorecard: {}, timeoutCount: 0 },
          { scorecard: {}, timeoutCount: 0 },
        ],
        result: { reason: 'explicitForfeit', winnerSeatIndex: 0 },
      },
    });
    expect(Number(view.presence.presenceVersion)).toBe(7);
    expect(view.presence.seats).toHaveLength(2);
  });

  test.each([
    {
      label: 'waiting room with a game',
      record: { ...waitingRecord(), match: playingRecord().match, stateVersion: 1 },
    },
    { label: 'playing room without a game', record: { ...playingRecord(), match: null } },
    {
      label: 'playing room with a finished game',
      record: { ...playingRecord(), match: finishedRecord().match },
    },
  ])('rejects an incoherent record: $label', ({ record }) => {
    expect(() => projectRoomView(record as unknown as RoomRecord)).toThrow();
  });

  test('projects a waiting room without presence or credential internals', () => {
    const projected = projectPublicRoom(waitingRoom());

    expect(parsePublicRoom(projected)).toEqual(projected);
    expect(projected as unknown).toEqual({
      status: 'waiting',
      roomId: ROOM_ID,
      roomCode: '001204',
      createdAt: 1_000,
      expiresAt: 301_000,
      seats: [
        {
          profile: { characterId: 'navy-bob', variant: false },
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toMatch(/presence|token|hash|disconnected/i);
  });

  test.each([
    { characterId: 'navy-bob', variant: true },
    { characterId: 'blonde-buns', variant: false },
  ])('preserves selected style for character $characterId', ({ characterId, variant }) => {
    const joined = joinRoom(waitingRoom(), { characterId, variant, joinedAt: 2_000 });
    if (!joined.ok) throw new Error('fixture join failed');

    const projected = projectPublicRoom(joined.room);
    if (projected.status !== 'playing') throw new Error('expected playing projection');

    expect(projected.seats[0].profile.variant).toBe(false);
    expect(projected.seats[1].profile).toEqual({ characterId, variant });
  });

  test('projects reconnectable both-disconnected play as public playing state', () => {
    const room = bothDisconnectedRoom();
    const projectedRoom = projectPublicRoom(room);
    const projectedPresence = projectPresenceSnapshot(room, 7);

    expect(parsePublicRoom(projectedRoom)).toEqual(projectedRoom);
    expect(projectedRoom.status).toBe('playing');
    expect(JSON.stringify(projectedRoom)).not.toContain('cleanup');
    expect(parsePresenceSnapshot(projectedPresence)).toEqual(projectedPresence);
    expect(projectedPresence as unknown).toEqual({
      roomId: ROOM_ID,
      presenceVersion: 7,
      seats: [
        {
          status: 'disconnected',
          reconnectDeadlineAt: 94_000,
        },
        {
          status: 'disconnected',
          reconnectDeadlineAt: 94_000,
        },
      ],
    });
  });

  test('rejects held slots on an unrolled turn instead of silently omitting them', () => {
    const match = createMatch({
      initialTurn: {
        id: turnId('018f47f2-c2d8-7f4a-8bf4-3f559c398441'),
        startedAt: epochMilliseconds(2_000),
      },
    });
    expect(() =>
      projectGameSnapshot(
        {
          ...match,
          currentTurn: { ...match.currentTurn, heldSlots: [0] },
        },
        1,
      ),
    ).toThrow();
  });

  test('projects Yacht players, seat mapping, turn state, and an independent state version', () => {
    const match = createMatch({
      initialTurn: {
        id: turnId('018f47f2-c2d8-7f4a-8bf4-3f559c398441'),
        startedAt: epochMilliseconds(2_000),
      },
    });
    const projected = projectGameSnapshot(match, 11);

    expect(parseGameSnapshot(projected)).toEqual(projected);
    expect(Number(projected.stateVersion)).toBe(11);
    expect(projected.match.players).toHaveLength(2);
    expect(projected.match).toMatchObject({
      status: 'playing',
      currentTurn: {
        turnId: '018f47f2-c2d8-7f4a-8bf4-3f559c398441',
        seatIndex: CREATOR_SEAT_INDEX,
        startedAt: 2_000,
        deadlineAt: 92_000,
        rollCount: 0,
        dice: null,
      },
    });
  });
});
