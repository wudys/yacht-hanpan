import { describe, expect, test } from 'bun:test';

import { GameApiParseError } from '../internal/parse';
import { CATEGORY_ID, MATCH_END_REASON } from './constants';
import {
  parseGameSnapshot,
  parsePresenceSnapshot,
  parsePublicRoom,
  parseRoomView,
} from './room-view';

const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const TURN_ID = 'c847f81e-8ee0-43ef-b09a-f8ef14612246';

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

const creatorSeat = {
  profile: { characterId: 'navy-bob', variant: false },
} as const;

const players = [
  {
    scorecard: { [CATEGORY_ID.ONES]: 3 },
    timeoutCount: 0,
  },
  {
    scorecard: {},
    timeoutCount: 1,
  },
] as const;

const identity = {
  roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843e',
  roomCode: '001204',
  createdAt: 1_000,
} as const;
const seats = [
  { profile: { characterId: 'navy-bob', variant: false } },
  { profile: { characterId: 'blonde-buns', variant: false } },
] as const;
const waiting = {
  room: { ...identity, status: 'waiting', expiresAt: 301_000, seats: [seats[0]] },
  game: null,
  presence: {
    roomId: identity.roomId,
    presenceVersion: 0,
    seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
  },
} as const;
const playing = {
  room: { ...identity, status: 'playing', startedAt: 2_000, seats },
  game: {
    stateVersion: 4,
    match: {
      status: 'playing',
      players: [
        { scorecard: {}, timeoutCount: 0 },
        { scorecard: {}, timeoutCount: 0 },
      ],
      currentTurn: {
        turnId: 'c847f81e-8ee0-43ef-b09a-f8ef14612246',
        seatIndex: 0,
        startedAt: 2_000,
        deadlineAt: 62_000,
        rollCount: 0,
        heldSlots: [],
        dice: null,
      },
    },
  },
  presence: {
    roomId: identity.roomId,
    presenceVersion: 2,
    seats: [{ status: 'connected' }, { status: 'connected' }],
  },
} as const;
const finished = {
  ...playing,
  room: { ...playing.room, status: 'finished', finishedAt: 3_000 },
  game: {
    stateVersion: 5,
    match: {
      status: 'finished',
      players: playing.game.match.players,
      result: { reason: 'explicitForfeit', winnerSeatIndex: 1 },
    },
  },
} as const;

describe('public room and presence snapshots', () => {
  test('parses an exact waiting room without authority material', () => {
    const room = {
      status: 'waiting',
      roomId: ROOM_ID,
      roomCode: '001204',
      createdAt: 1_000,
      expiresAt: 301_000,
      seats: [creatorSeat],
    };
    expect(plain(parsePublicRoom(room))).toEqual(room);
    expect(JSON.stringify(parsePublicRoom(room))).not.toMatch(/seatToken|credential|socket/iu);
  });

  test.each([
    { character: 1, variant: false },
    { characterId: 1, variant: false },
    { characterId: 'navy-bob', variant: 'variant' },
  ])('rejects a legacy public profile: %p', (profile) => {
    expect(() =>
      parsePublicRoom({
        status: 'waiting',
        roomId: ROOM_ID,
        roomCode: '001204',
        createdAt: 1_000,
        expiresAt: 301_000,
        seats: [{ profile }],
      }),
    ).toThrow(GameApiParseError);
  });

  test('keeps presence ordering independent from game state', () => {
    const presence = {
      roomId: ROOM_ID,
      presenceVersion: 4,
      seats: [
        { status: 'connected' },
        {
          status: 'disconnected',
          reconnectDeadlineAt: 95_000,
        },
      ],
    };
    expect(plain(parsePresenceSnapshot(presence))).toEqual(presence);
  });

  test.each([
    {
      status: 'waiting',
      roomId: ROOM_ID,
      roomCode: '001204',
      createdAt: 1_000,
      expiresAt: 301_000,
      seats: [creatorSeat],
      seatToken: 'secret',
    },
    {
      roomId: ROOM_ID,
      presenceVersion: 1,
      seats: [{ status: 'connected', socketId: 'private' }],
    },
  ])('rejects private or unknown snapshot fields', (value) => {
    expect(() =>
      'status' in value ? parsePublicRoom(value) : parsePresenceSnapshot(value),
    ).toThrow(GameApiParseError);
  });
});

describe('game snapshot', () => {
  test('rejects legacy die membership even when it agrees with heldSlots', () => {
    expect(() =>
      parseGameSnapshot({
        stateVersion: 1,
        match: {
          status: 'playing',
          players,
          currentTurn: {
            turnId: TURN_ID,
            seatIndex: 0,
            startedAt: 1_000,
            deadlineAt: 61_000,
            rollCount: 1,
            heldSlots: [0],
            dice: [1, 2, 3, 4, 5].map((value, slot) => ({ value, isHeld: slot === 0 })),
          },
        },
      }),
    ).toThrow(GameApiParseError);
  });

  test.each([
    { heldSlots: [3, 0], valid: true },
    { heldSlots: [0, 3], valid: true },
    { heldSlots: [3, 3], valid: false },
    { heldSlots: [3], valid: true },
    { heldSlots: [3, 0, 1], valid: true },
    { heldSlots: [3, 5], valid: false },
    { heldSlots: [-1], valid: false },
    { heldSlots: [0.5], valid: false },
    { heldSlots: [], valid: true },
    { heldSlots: [4, 2, 0, 3, 1], valid: true },
    { heldSlots: undefined, valid: false },
  ])(
    'validates ordered hold membership independently from die values: %p',
    ({ heldSlots, valid }) => {
      const snapshot = {
        stateVersion: 1,
        match: {
          status: 'playing',
          players,
          currentTurn: {
            turnId: TURN_ID,
            seatIndex: 0,
            startedAt: 1_000,
            deadlineAt: 61_000,
            rollCount: 1,
            heldSlots,
            dice: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }],
          },
        },
      };
      if (valid) expect(plain(parseGameSnapshot(snapshot))).toEqual(snapshot);
      else expect(() => parseGameSnapshot(snapshot)).toThrow(GameApiParseError);
    },
  );

  test.each([
    { rollCount: 0, heldSlots: [], dice: null, valid: true },
    { rollCount: 0, heldSlots: [0], dice: null, valid: false },
    { rollCount: 1, heldSlots: [], dice: [1, 2, 3, 4].map((value) => ({ value })), valid: false },
    {
      rollCount: 1,
      heldSlots: [],
      dice: [1, 2, 3, 4, 5, 6].map((value) => ({ value })),
      valid: false,
    },
  ])(
    'keeps unrolled membership empty and rolled dice a five-value tuple: %p',
    ({ valid, ...state }) => {
      const snapshot = {
        stateVersion: 1,
        match: {
          status: 'playing',
          players,
          currentTurn: {
            turnId: TURN_ID,
            seatIndex: 0,
            startedAt: 1_000,
            deadlineAt: 61_000,
            ...state,
          },
        },
      };
      if (valid) expect(plain(parseGameSnapshot(snapshot))).toEqual(snapshot);
      else expect(() => parseGameSnapshot(snapshot)).toThrow(GameApiParseError);
    },
  );

  test('parses a full playing state whose fixed tuple positions identify dice', () => {
    const snapshot = {
      stateVersion: 7,
      match: {
        status: 'playing',
        players,
        currentTurn: {
          turnId: TURN_ID,
          seatIndex: 0,
          startedAt: 10_000,
          deadlineAt: 70_000,
          rollCount: 1,
          heldSlots: [1],
          dice: [{ value: 1 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }],
        },
      },
    };
    expect(plain(parseGameSnapshot(snapshot))).toEqual(snapshot);
  });

  test('parses a finished state with an explicit result', () => {
    const snapshot = {
      stateVersion: 9,
      match: {
        status: 'finished',
        players,
        result: {
          reason: MATCH_END_REASON.EXPLICIT_FORFEIT,
          winnerSeatIndex: 0,
        },
      },
    };
    expect(plain(parseGameSnapshot(snapshot))).toEqual(snapshot);
  });

  test.each([
    { reason: MATCH_END_REASON.EXPLICIT_FORFEIT, winnerSeatIndex: null },
    { reason: MATCH_END_REASON.CONNECTION_ENDED, loserSeatIndex: 1 },
  ])('rejects an invalid decided result', (result) => {
    expect(() =>
      parseGameSnapshot({
        stateVersion: 9,
        match: { status: 'finished', players, result },
      }),
    ).toThrow(GameApiParseError);
  });

  test.each([
    {
      stateVersion: 1,
      match: {
        status: 'playing',
        players,
        currentTurn: {
          turnId: TURN_ID,
          seatIndex: 0,
          startedAt: 1,
          deadlineAt: 2,
          rollCount: 0,
          heldSlots: [],
          dice: [],
        },
      },
    },
    {
      stateVersion: 1,
      match: {
        status: 'playing',
        players: [{ ...players[0], scorecard: { unknown: 5 } }, players[1]],
        currentTurn: {
          turnId: TURN_ID,
          seatIndex: 0,
          startedAt: 1,
          deadlineAt: 2,
          rollCount: 0,
          heldSlots: [],
          dice: null,
        },
      },
    },
    { stateVersion: 1, match: { status: 'playing', players, currentTurn: null }, timeline: [] },
  ])('rejects impossible or historical animation state', (value) => {
    expect(() => parseGameSnapshot(value)).toThrow(GameApiParseError);
  });
});

describe('complete room view', () => {
  test.each([waiting, playing, finished])('accepts a coherent $room.status view', (view) => {
    expect<unknown>(parseRoomView(view)).toEqual(view);
  });

  test.each([
    {
      ...playing,
      presence: { ...playing.presence, roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c398440' },
    },
    { ...playing, presence: waiting.presence },
    { ...playing, game: null },
    { ...waiting, game: playing.game },
    { ...finished, game: playing.game },
  ])('rejects separately valid fields from different room states', (view) => {
    expect(() => parseRoomView(view)).toThrow(GameApiParseError);
  });

  test('rejects private application state in the public envelope or seats', () => {
    expect(() => parseRoomView({ ...waiting, actionLedger: [] })).toThrow(GameApiParseError);
    expect(() =>
      parseRoomView({
        ...waiting,
        room: { ...waiting.room, seats: [{ ...seats[0], seatTokenHash: 'fixture-only' }] },
      }),
    ).toThrow(GameApiParseError);
  });
});
