import { describe, expect, test } from 'bun:test';

import { PUBLIC_ERROR_CODE } from '../errors';
import { GameApiParseError } from '../internal/parse';
import { parseSyncAck } from '../socket';
import { GAME_PROTOCOL_VERSION } from '../version';
import {
  HTTP_METHOD,
  matchRoomHttpPath,
  parseCancelRoomBody,
  parseCancelRoomRequest,
  parseCancelRoomResponse,
  parseCreateRoomRequest,
  parseCreateRoomResponse,
  parseJoinRoomBody,
  parseJoinRoomRequest,
  parseJoinRoomResponse,
  parseResumeRoomBody,
  parseResumeRoomRequest,
  parseResumeRoomResponse,
  ROOM_HTTP_PATH,
  ROOM_HTTP_ROUTE_KIND,
  safeParseRoomAuthority,
} from './index';

const CLIENT_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843d';
const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const TURN_ID = 'c847f81e-8ee0-43ef-b09a-f8ef14612246';
const SEAT_TOKEN = 'd0379b77-4d7b-4611-83fc-d5dcde34bdc2';
const REQUEST_ID = '97353947-22b7-4de5-b2e5-a3110ef752a4';
const OPERATION_ID = 'f575f46d-9c2f-4ff8-b5cc-acec3e8d3669';
const meta = {
  requestId: REQUEST_ID,
  gameProtocolVersion: GAME_PROTOCOL_VERSION,
  serverTime: 1_000,
} as const;

test.each([0, 1])(
  'general room authority accepts seat %s and rejects malformed input',
  (seatIndex) => {
    expect(
      safeParseRoomAuthority({ roomId: ROOM_ID, seatIndex, seatToken: SEAT_TOKEN }),
    ).toMatchObject({ success: true });
    const invalid = safeParseRoomAuthority({
      roomId: ROOM_ID,
      seatIndex: 0,
      seatToken: SEAT_TOKEN,
      locale: 'ko',
    });
    expect(invalid).toEqual({ success: false, error: new GameApiParseError() });
    expect(JSON.stringify(invalid)).not.toContain('path');
    expect(JSON.stringify(invalid)).not.toContain('locale');
  },
);

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
const selectedProfile = { characterId: 'navy-bob', variant: false } as const;
const profile = { ...selectedProfile, variant: false } as const;
const creatorSeat = { profile } as const;
const joinerSeat = {
  profile: { characterId: 'blonde-buns', variant: true },
} as const;
const waitingRoom = {
  status: 'waiting',
  roomId: ROOM_ID,
  roomCode: '001204',
  createdAt: 1_000,
  expiresAt: 301_000,
  seats: [creatorSeat],
} as const;
const playingRoom = {
  status: 'playing',
  roomId: ROOM_ID,
  roomCode: '001204',
  createdAt: 1_000,
  startedAt: 2_000,
  seats: [creatorSeat, joinerSeat],
} as const;
const presence = {
  roomId: ROOM_ID,
  presenceVersion: 1,
  seats: [{ status: 'connected' }, { status: 'connected' }],
} as const;
const game = {
  stateVersion: 1,
  match: {
    status: 'playing',
    players: [
      {
        scorecard: {},
        timeoutCount: 0,
      },
      {
        scorecard: {},
        timeoutCount: 0,
      },
    ],
    currentTurn: {
      turnId: TURN_ID,
      seatIndex: 0,
      startedAt: 2_000,
      deadlineAt: 62_000,
      rollCount: 0,
      heldSlots: [],
      dice: null,
    },
  },
} as const;

const waitingView = {
  room: waitingRoom,
  game: null,
  presence: {
    roomId: ROOM_ID,
    presenceVersion: 0,
    seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
  },
} as const;
const playingView = { room: playingRoom, game, presence } as const;

describe('room bootstrap requests', () => {
  test('owns room HTTP methods and path construction in one public contract', () => {
    const joinRequest = parseJoinRoomRequest({
      clientId: CLIENT_ID,
      operationId: OPERATION_ID,
      roomCode: '001204',
      profile: selectedProfile,
    });
    const resumeRequest = parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN });
    const cancelRequest = parseCancelRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN });

    expect(HTTP_METHOD.POST).toBe('POST');
    expect(ROOM_HTTP_PATH.CREATE).toBe('/rooms');
    expect(ROOM_HTTP_PATH.join(joinRequest.roomCode)).toBe('/rooms/001204/join');
    expect(ROOM_HTTP_PATH.resume(resumeRequest.roomId)).toBe(`/rooms/${ROOM_ID}/resume`);
    expect(ROOM_HTTP_PATH.cancel(cancelRequest.roomId)).toBe(`/rooms/${ROOM_ID}/cancel`);
    expect(matchRoomHttpPath('/rooms')).toEqual({ kind: ROOM_HTTP_ROUTE_KIND.CREATE });
    expect(matchRoomHttpPath('/rooms/001204/join')).toEqual({
      kind: ROOM_HTTP_ROUTE_KIND.JOIN,
      roomCode: '001204',
    });
    expect(matchRoomHttpPath(`/rooms/${ROOM_ID}/resume`)).toEqual({
      kind: ROOM_HTTP_ROUTE_KIND.RESUME,
      roomId: ROOM_ID,
    });
    expect(matchRoomHttpPath(`/rooms/${ROOM_ID}/cancel`)).toEqual({
      kind: ROOM_HTTP_ROUTE_KIND.CANCEL,
      roomId: ROOM_ID,
    });
    expect(matchRoomHttpPath('/rooms/resume')).toBeNull();
    expect(matchRoomHttpPath('/rooms/001204/join/extra')).toBeNull();
  });

  test('strictly parses create, join, resume, and cancel inputs', () => {
    expect(
      parseCreateRoomRequest({
        clientId: CLIENT_ID,
        operationId: OPERATION_ID,
        profile: selectedProfile,
      }),
    ).toBeTruthy();
    expect(
      parseJoinRoomRequest({
        clientId: CLIENT_ID,
        operationId: OPERATION_ID,
        roomCode: '001204',
        profile: selectedProfile,
      }),
    ).toBeTruthy();
    expect(parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN })).toBeTruthy();
    expect(parseCancelRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN })).toBeTruthy();
    expect(
      parseJoinRoomBody({
        clientId: CLIENT_ID,
        operationId: OPERATION_ID,
        profile: selectedProfile,
      }),
    ).toBeTruthy();
    expect(parseResumeRoomBody({ seatToken: SEAT_TOKEN })).toBeTruthy();
    expect(parseCancelRoomBody({ seatToken: SEAT_TOKEN })).toBeTruthy();
  });

  test.each([
    { character: 1 },
    { characterId: 1 },
    { characterId: 'unknown', variant: false },
    { characterId: 'navy-bob' },
    { characterId: 'navy-bob', variant: 'false' },
  ])('rejects legacy or unknown profile selection: %p', (invalidProfile) => {
    expect(() =>
      parseCreateRoomRequest({
        clientId: CLIENT_ID,
        operationId: OPERATION_ID,
        profile: invalidProfile,
      }),
    ).toThrow(GameApiParseError);
  });

  test('keeps path parameters out of HTTP bodies', () => {
    expect(() =>
      parseJoinRoomBody({
        clientId: CLIENT_ID,
        operationId: OPERATION_ID,
        profile: selectedProfile,
        roomCode: '001204',
      }),
    ).toThrow(GameApiParseError);
    expect(() => parseResumeRoomBody({ roomId: ROOM_ID, seatToken: SEAT_TOKEN })).toThrow(
      GameApiParseError,
    );
    expect(() => parseCancelRoomBody({ roomId: ROOM_ID, seatToken: SEAT_TOKEN })).toThrow(
      GameApiParseError,
    );
  });

  test('requires a valid operation id for authority-issuing mutations', () => {
    expect(() => parseCreateRoomRequest({ clientId: CLIENT_ID, profile: selectedProfile })).toThrow(
      GameApiParseError,
    );
    expect(() =>
      parseJoinRoomRequest({
        clientId: CLIENT_ID,
        operationId: 'not-a-uuid',
        roomCode: '001204',
        profile: selectedProfile,
      }),
    ).toThrow(GameApiParseError);
  });

  test.each([
    () =>
      parseCreateRoomRequest({
        clientId: CLIENT_ID,
        operationId: OPERATION_ID,
        profile: selectedProfile,
        locale: 'ko',
      }),
    () =>
      parseCreateRoomRequest({
        clientId: CLIENT_ID,
        operationId: OPERATION_ID,
        profile: { ...profile, imageUrl: '/untrusted.png' },
      }),
    () =>
      parseJoinRoomRequest({
        clientId: CLIENT_ID,
        operationId: OPERATION_ID,
        roomCode: '001204',
        profile: selectedProfile,
        seatId: 'x',
      }),
    () => parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN, clientId: CLIENT_ID }),
  ])('rejects unknown request fields', (parse) => {
    expect(parse).toThrow(GameApiParseError);
  });
});

describe('room bootstrap responses', () => {
  test('rejects legacy flat admission responses and a seat absent from a waiting view', () => {
    expect(() =>
      parseCreateRoomResponse({
        ok: true,
        data: {
          authority: { roomId: ROOM_ID, seatIndex: 0, seatToken: SEAT_TOKEN },
          room: waitingRoom,
        },
        meta,
      }),
    ).toThrow(GameApiParseError);
    expect(() =>
      parseJoinRoomResponse({
        ok: true,
        data: {
          authority: { roomId: ROOM_ID, seatIndex: 1, seatToken: SEAT_TOKEN },
          ...playingView,
        },
        meta,
      }),
    ).toThrow(GameApiParseError);
    expect(() =>
      parseResumeRoomResponse({ ok: true, data: { seatIndex: 1, view: waitingView }, meta }),
    ).toThrow(GameApiParseError);
  });
  test('issues creator authority in create success', () => {
    const response = {
      ok: true,
      data: {
        authority: { roomId: ROOM_ID, seatIndex: 0, seatToken: SEAT_TOKEN },
        view: waitingView,
      },
      meta,
    };
    expect(plain(parseCreateRoomResponse(response))).toEqual(response);
  });

  test('issues joiner authority and the initial match in join success', () => {
    const response = {
      ok: true,
      data: {
        authority: { roomId: ROOM_ID, seatIndex: 1, seatToken: SEAT_TOKEN },
        view: playingView,
      },
      meta,
    };
    expect(plain(parseJoinRoomResponse(response))).toEqual(response);
  });

  for (const invalid of ['roomId', 'seatIndex'] as const) {
    test.each([
      ['create', parseCreateRoomResponse, { view: waitingView }, 0],
      ['join', parseJoinRoomResponse, { view: playingView }, 1],
    ] as const)(
      `%s rejects authority ${invalid} mismatch`,
      (_operation, parse, data, seatIndex) => {
        const authority = { roomId: ROOM_ID, seatIndex, seatToken: SEAT_TOKEN };
        const response = { ok: true, data: { ...data, authority }, meta };
        expect(parse(response).ok).toBe(true);
        const mismatched =
          invalid === 'roomId'
            ? { ...authority, roomId: CLIENT_ID }
            : { ...authority, seatIndex: seatIndex === 0 ? 1 : 0 };
        expect(() => parse({ ...response, data: { ...data, authority: mismatched } })).toThrow(
          GameApiParseError,
        );
      },
    );
  }

  test('resume verifies authority but never echoes the token', () => {
    const response = {
      ok: true,
      data: { seatIndex: 0, view: playingView },
      meta,
    };
    expect(plain(parseResumeRoomResponse(response))).toEqual(response);
    expect(JSON.stringify(parseResumeRoomResponse(response))).not.toContain(SEAT_TOKEN);
  });

  test('cancel confirms removal without echoing authority', () => {
    const response = { ok: true, data: { cancelled: true }, meta } as const;
    expect(plain(parseCancelRoomResponse(response))).toEqual(response);
    expect(JSON.stringify(parseCancelRoomResponse(response))).not.toContain(SEAT_TOKEN);
  });

  test('uses the same public error semantics for HTTP', () => {
    const response = {
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: {} },
      meta,
    };
    expect(plain(parseJoinRoomResponse(response))).toEqual(response);
  });

  test.each([
    {
      parse: parseCreateRoomResponse,
      value: {
        ok: true,
        data: {
          authority: { roomId: ROOM_ID, seatIndex: 0, seatToken: SEAT_TOKEN },
          view: playingView,
        },
        meta,
      },
    },
    {
      parse: parseResumeRoomResponse,
      value: {
        ok: true,
        data: {
          seatIndex: 0,
          seatToken: SEAT_TOKEN,
          view: playingView,
        },
        meta,
      },
    },
    {
      parse: parseJoinRoomResponse,
      value: {
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: {} },
        data: { room: playingRoom },
        meta,
      },
    },
  ])('rejects wrong lifecycle, token leakage, or contradictory envelopes', ({ parse, value }) => {
    expect(() => parse(value)).toThrow(GameApiParseError);
  });
});

describe('transport-independent snapshot coherence', () => {
  const finishedRoom = { ...playingRoom, status: 'finished', finishedAt: 3_000 };
  const finishedGame = {
    stateVersion: 2,
    match: {
      status: 'finished',
      players: game.match.players,
      result: { reason: 'scoresCompleted', winnerSeatIndex: null },
    },
  };

  test.each([
    ['playing', { room: playingRoom, game, presence }],
    [
      'waiting',
      { room: waitingRoom, game: null, presence: { ...presence, seats: [presence.seats[0]] } },
    ],
    ['finished', { room: finishedRoom, game: finishedGame, presence }],
  ])('accepts a coherent %s resume and sync', (_, data) => {
    expect(() =>
      parseResumeRoomResponse({ ok: true, data: { view: data, seatIndex: 0 }, meta }),
    ).not.toThrow();
    expect(() => parseSyncAck({ ok: true, data, meta })).not.toThrow();
  });

  test.each([
    ['room ID', { room: playingRoom, game, presence: { ...presence, roomId: CLIENT_ID } }],
    [
      'seat count',
      { room: playingRoom, game, presence: { ...presence, seats: [presence.seats[0]] } },
    ],
    ['playing room and finished game', { room: playingRoom, game: finishedGame, presence }],
  ])('rejects incoherent %s across join, resume, and sync', (_, data) => {
    expect(() =>
      parseJoinRoomResponse({
        ok: true,
        data: {
          view: data,
          authority: { roomId: ROOM_ID, seatIndex: 1, seatToken: SEAT_TOKEN },
        },
        meta,
      }),
    ).toThrow(GameApiParseError);
    expect(() =>
      parseResumeRoomResponse({ ok: true, data: { view: data, seatIndex: 0 }, meta }),
    ).toThrow(GameApiParseError);
    expect(() => parseSyncAck({ ok: true, data, meta })).toThrow(GameApiParseError);
  });

  test('rejects a finished room with a playing game in resume and sync', () => {
    const data = { room: finishedRoom, game, presence };
    expect(() =>
      parseResumeRoomResponse({ ok: true, data: { view: data, seatIndex: 0 }, meta }),
    ).toThrow(GameApiParseError);
    expect(() => parseSyncAck({ ok: true, data, meta })).toThrow(GameApiParseError);
  });
});
