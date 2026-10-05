import { DICE_SIMULATION_CONTRACT } from '@repo/dice-simulation/contract';
import { CATEGORY_IDS } from '@repo/yacht-rules';
import { describe, expect, test } from 'bun:test';

import { PUBLIC_ERROR_CODE } from '../errors';
import { GameApiParseError } from '../internal/parse';
import { GAME_PROTOCOL_VERSION } from '../version';
import {
  GAME_COMMAND_TYPE,
  GAME_SOCKET_PATH,
  parseGameCommand,
  parseSocketAuth,
  parseSocketConnectionFailure,
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
