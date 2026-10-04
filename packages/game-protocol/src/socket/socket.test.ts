import { DICE_SIMULATION_CONTRACT, POUR_STYLE } from '@repo/dice-simulation/contract';
import { CATEGORY_IDS } from '@repo/yacht-rules';
import { describe, expect, test } from 'bun:test';

import { PUBLIC_ERROR_CODE } from '../errors';
import { GameApiParseError } from '../internal/parse';
import { GAME_PROTOCOL_VERSION } from '../version';
import {
  GAME_COMMAND_TYPE,
  GAME_SOCKET_PATH,
  parseCommandAck,
  parseGameCommand,
  parseSocketAuth,
  parseSocketConnectionFailure,
  parseSyncAck,
  SOCKET_EVENT,
} from './index';

const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const SEAT_TOKEN = 'd0379b77-4d7b-4611-83fc-d5dcde34bdc2';
const ACTION_ID = 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d';
const TURN_ID = 'c847f81e-8ee0-43ef-b09a-f8ef14612246';
const REQUEST_ID = '97353947-22b7-4de5-b2e5-a3110ef752a4';
const contract = {
  releaseId: '2026-08-12.1-a5905df',
  gameProtocolVersion: GAME_PROTOCOL_VERSION,
  simulationVersion: DICE_SIMULATION_CONTRACT.simulationVersion,
  timelineSchemaVersion: DICE_SIMULATION_CONTRACT.timelineSchemaVersion,
} as const;
const meta = { requestId: REQUEST_ID, gameProtocolVersion: GAME_PROTOCOL_VERSION } as const;
const roll = {
  type: 'roll:resolved',
  replay: {
    mode: 'seeded-physics',
    rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
    seed: 'server-csprng-seed',
    pourStyle: POUR_STYLE.CLASSIC,
    rolledSlots: [0],
    contract,
  },
  outcome: { authoritativeValuesBySlot: [{ slot: 0, value: 6 }] },
  replayDigest: `${DICE_SIMULATION_CONTRACT.replayDigestVersion}:${'a'.repeat(64)}`,
} as const;

const view = {
  room: {
    status: 'playing',
    roomId: ROOM_ID,
    roomCode: '001204',
    createdAt: 1_000,
    startedAt: 2_000,
    seats: [
      { profile: { characterId: 'navy-bob', variant: false } },
      { profile: { characterId: 'blonde-buns', variant: false } },
    ],
  },
  game: {
    stateVersion: 5,
    match: {
      status: 'playing',
      players: [
        { scorecard: {}, timeoutCount: 0 },
        { scorecard: {}, timeoutCount: 0 },
      ],
      currentTurn: {
        turnId: TURN_ID,
        seatIndex: 0,
        startedAt: 2_000,
        deadlineAt: 62_000,
        rollCount: 1,
        heldSlots: [],
        dice: [{ value: 6 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }],
      },
    },
  },
  presence: {
    roomId: ROOM_ID,
    presenceVersion: 2,
    seats: [{ status: 'connected' }, { status: 'connected' }],
  },
} as const;

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test('owns the public Socket.IO transport path', () => {
  expect(GAME_SOCKET_PATH).toBe('/game-socket');
});

describe('socket authentication and event names', () => {
  test('authenticates with authority, execution intent, and exact contract', () => {
    expect(
      parseSocketAuth({
        executionId: crypto.randomUUID(),
        connectionIntent: 'enter',
        roomId: ROOM_ID,
        seatToken: SEAT_TOKEN,
        contract,
      }),
    ).toBeTruthy();
    expect(() =>
      parseSocketAuth({
        executionId: crypto.randomUUID(),
        connectionIntent: 'enter',
        roomId: ROOM_ID,
        seatToken: SEAT_TOKEN,
        contract,
        locale: 'ko',
      }),
    ).toThrow(GameApiParseError);
  });

  test('rejects legacy or malformed execution authentication', () => {
    const authority = { roomId: ROOM_ID, seatToken: SEAT_TOKEN, contract };
    expect(() => parseSocketAuth(authority)).toThrow(GameApiParseError);
    expect(() =>
      parseSocketAuth({ ...authority, executionId: 'not-an-id', connectionIntent: 'enter' }),
    ).toThrow(GameApiParseError);
    expect(() =>
      parseSocketAuth({
        ...authority,
        executionId: crypto.randomUUID(),
        connectionIntent: 'replace-every-time',
      }),
    ).toThrow(GameApiParseError);
    expect(
      parseSocketAuth({
        ...authority,
        executionId: crypto.randomUUID(),
        connectionIntent: 'reconnect',
      }).connectionIntent,
    ).toBe('reconnect');
  });

  test('centralizes the low-level event names', () => {
    expect(SOCKET_EVENT).toEqual({
      GAME_COMMAND: 'game:command',
      GAME_SYNC: 'game:sync',
      ROOM_STATE: 'room:state',
      SESSION_REPLACED: 'session:replaced',
    });
  });
});

describe('game commands', () => {
  test.each([
    { type: GAME_COMMAND_TYPE.ROLL_DICE, actionId: ACTION_ID, turnId: TURN_ID },
    {
      type: GAME_COMMAND_TYPE.SET_DIE_HELD,
      actionId: ACTION_ID,
      turnId: TURN_ID,
      slot: 2,
      isHeld: true,
    },
    { type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID },
  ])('strictly parses %s', (command) => {
    expect(parseGameCommand(command)).toBeTruthy();
  });

  test.each([...CATEGORY_IDS])(
    'preserves the rules category %s in a score command',
    (categoryId) => {
      const command = {
        type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
        actionId: ACTION_ID,
        turnId: TURN_ID,
        categoryId,
      };

      expect(plain(parseGameCommand(command))).toEqual(command);
    },
  );

  test('rejects an unsupported score category', () => {
    expect(() =>
      parseGameCommand({
        type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
        actionId: ACTION_ID,
        turnId: TURN_ID,
        categoryId: 'unknown',
      }),
    ).toThrow(GameApiParseError);
  });

  test.each([
    { type: GAME_COMMAND_TYPE.ROLL_DICE, actionId: ACTION_ID, turnId: TURN_ID, seed: 'client' },
    { type: GAME_COMMAND_TYPE.ROLL_DICE, actionId: ACTION_ID, turnId: TURN_ID, diceCount: 5 },
    { type: GAME_COMMAND_TYPE.ROLL_DICE, actionId: ACTION_ID, turnId: TURN_ID, heldSlots: [1] },
    { type: GAME_COMMAND_TYPE.ROLL_DICE, actionId: ACTION_ID, turnId: TURN_ID, targetFaces: [6] },
    {
      type: GAME_COMMAND_TYPE.ROLL_DICE,
      actionId: ACTION_ID,
      turnId: TURN_ID,
      roomId: ROOM_ID,
    },
  ])('rejects client-owned roll authority and room claims', (command) => {
    expect(() => parseGameCommand(command)).toThrow(GameApiParseError);
  });

  test('keeps forfeit independent from the active turn', () => {
    expect(
      plain(parseGameCommand({ type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID })),
    ).toEqual({ type: GAME_COMMAND_TYPE.FORFEIT_MATCH, actionId: ACTION_ID });
    expect(() =>
      parseGameCommand({
        type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
        actionId: ACTION_ID,
        turnId: TURN_ID,
      }),
    ).toThrow(GameApiParseError);
  });
});

describe('socket acknowledgements', () => {
  test('parses command success with distinct request/action/state identifiers', () => {
    const ack = {
      ok: true,
      data: { receipt: { stateVersion: 4 }, view },
      meta: { ...meta, actionId: ACTION_ID },
    };
    expect(plain(parseCommandAck(ack))).toEqual(ack);
  });

  test('parses a strict roll success carrying the authoritative compact artifact', () => {
    const ack = {
      ok: true,
      data: { receipt: { stateVersion: 5, roll }, view },
      meta: { ...meta, actionId: ACTION_ID },
    };
    expect(plain(parseCommandAck(ack))).toEqual(ack);
  });

  test.each([
    { stateVersion: 5, roll: { ...roll, timeline: [] } },
    { stateVersion: 5, roll: { ...roll, targetFaces: [6] } },
    { stateVersion: 5, roll, extra: true },
  ])('rejects an expanded or contradictory roll success payload', (data) => {
    expect(() =>
      parseCommandAck({
        ok: true,
        data: { receipt: data, view },
        meta: { ...meta, actionId: ACTION_ID },
      }),
    ).toThrow(GameApiParseError);
  });

  test('shares public error semantics without private messages', () => {
    const ack = {
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.STALE_TURN, params: {} },
      meta: { ...meta, actionId: ACTION_ID },
    };
    expect(plain(parseCommandAck(ack))).toEqual(ack);
    expect(JSON.stringify(parseCommandAck(ack))).not.toMatch(/message|stack|token/iu);
  });

  test('represents malformed commands without inventing an action identifier', () => {
    const ack = {
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST, params: {} },
      meta: { ...meta, actionId: null },
    };
    expect(plain(parseCommandAck(ack))).toEqual(ack);
    expect(() =>
      parseCommandAck({
        ...ack,
        error: { code: PUBLIC_ERROR_CODE.STALE_TURN, params: {} },
      }),
    ).toThrow(GameApiParseError);
  });

  test.each([
    {
      ok: true,
      data: { receipt: { stateVersion: 4 }, view },
      error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
      meta: { ...meta, actionId: ACTION_ID },
    },
    {
      ok: false,
      error: { code: 'PRIVATE_WORKER_ERROR', params: {} },
      meta: { ...meta, actionId: ACTION_ID },
    },
  ])('rejects contradictory or unknown acknowledgements', (ack) => {
    expect(() => parseCommandAck(ack)).toThrow(GameApiParseError);
  });

  test('sync success carries strict public room metadata without credentials', () => {
    const ack = {
      ok: true,
      data: {
        room: {
          status: 'playing',
          roomId: ROOM_ID,
          roomCode: '001204',
          createdAt: 1_000,
          startedAt: 2_000,
          seats: [
            { profile: { characterId: 'navy-bob', variant: false } },
            { profile: { characterId: 'blonde-buns', variant: false } },
          ],
        },
        game: {
          stateVersion: 1,
          match: {
            status: 'playing',
            players: [
              { scorecard: {}, timeoutCount: 0 },
              { scorecard: {}, timeoutCount: 0 },
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
        },
        presence: {
          roomId: ROOM_ID,
          presenceVersion: 1,
          seats: [{ status: 'connected' }, { status: 'connected' }],
        },
      },
      meta: { ...meta, serverTime: 2_000 },
    } as const;

    expect(plain(parseSyncAck(ack))).toEqual(ack);
    expect(JSON.stringify(parseSyncAck(ack))).not.toMatch(/seatToken|clientId|imageUrl/iu);
    expect(() =>
      parseSyncAck({
        ...ack,
        data: {
          ...ack.data,
          room: {
            ...ack.data.room,
            seats: [
              { profile: { characterId: 'navy-bob', variant: false }, seatToken: SEAT_TOKEN },
              ack.data.room.seats[1],
            ],
          },
        },
      }),
    ).toThrow(GameApiParseError);
  });

  test('rejects a full sync whose room, game, and presence are not one coherent snapshot', () => {
    const waiting = {
      ok: true,
      data: {
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
          presenceVersion: 1,
          seats: [{ status: 'connected' }],
        },
      },
      meta: { ...meta, serverTime: 2_000 },
    } as const;

    expect(() =>
      parseSyncAck({
        ...waiting,
        data: {
          ...waiting.data,
          presence: { ...waiting.data.presence, roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c398444' },
        },
      }),
    ).toThrow(GameApiParseError);
    expect(() =>
      parseSyncAck({
        ...waiting,
        data: {
          ...waiting.data,
          game: {
            stateVersion: 1,
            match: {
              status: 'finished',
              players: [
                { scorecard: {}, timeoutCount: 0 },
                { scorecard: {}, timeoutCount: 0 },
              ],
              result: { reason: 'scoresCompleted', winnerSeatIndex: null },
            },
          },
        },
      }),
    ).toThrow(GameApiParseError);
  });

  test('sync failure uses the same envelope and no actionId', () => {
    const ack = {
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, params: {} },
      meta,
    };
    expect(plain(parseSyncAck(ack))).toEqual(ack);
    expect(() => parseSyncAck({ ...ack, meta: { ...meta, actionId: ACTION_ID } })).toThrow(
      GameApiParseError,
    );
  });
});

describe('socket connection failures', () => {
  test('uses a strict locale-neutral public error envelope', () => {
    const failure = {
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} },
      meta,
    };
    expect(plain(parseSocketConnectionFailure(failure))).toEqual(failure);
    expect(() => parseSocketConnectionFailure({ ...failure, message: 'private' })).toThrow(
      GameApiParseError,
    );
  });
});
