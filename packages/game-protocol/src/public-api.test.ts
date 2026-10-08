import { GAME_PROTOCOL_VERSION as ROOT_GAME_PROTOCOL_VERSION } from '@repo/game-protocol';
import * as root from '@repo/game-protocol';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomRequest } from '@repo/game-protocol/http';
import { GAME_COMMAND_TYPE } from '@repo/game-protocol/socket';
import * as socket from '@repo/game-protocol/socket';
import * as state from '@repo/game-protocol/state';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

describe('package entry points', () => {
  test('resolve every approved subpath through package exports', () => {
    expect(PUBLIC_ERROR_CODE.INVALID_REQUEST).toBe('INVALID_REQUEST');
    expect(GAME_COMMAND_TYPE.ROLL_DICE).toBe('rollDice');
    expect(GAME_PROTOCOL_VERSION).toBe('game-protocol-v17');
    expect(ROOT_GAME_PROTOCOL_VERSION).toBe(GAME_PROTOCOL_VERSION);
    expect(
      parseCreateRoomRequest({
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        operationId: '4ba1e7d4-c077-4b80-b198-9b1f04c182c8',
        profile: { characterId: 'navy-bob', variant: false },
      }),
    ).toBeTruthy();
  });

  test('exposes common state through state and root while keeping socket transport-specific', () => {
    const stateExports = { ...state };
    const rootExports = { ...root };
    const socketExports = { ...socket };
    const names = [
      'CATEGORY_ID',
      'CATEGORY_IDS',
      'MATCH_END_REASON',
      'MATCH_STATUS',
      'PRESENCE_STATUS',
      'ROOM_STATUS',
      'parseGameSnapshot',
      'parsePresenceSnapshot',
      'parsePublicRoom',
      'parseRoomView',
    ] as const;
    expect(Object.keys(state).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(rootExports[name]).toBe(stateExports[name]);
      expect(Object.hasOwn(socketExports, name)).toBe(false);
    }
    for (const [name, value] of Object.entries(socketExports)) {
      expect(rootExports[name as keyof typeof socket]).toBe(value);
    }
    const view = {
      room: {
        roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        roomCode: '123456',
        createdAt: 1_000,
        expiresAt: 301_000,
        status: state.ROOM_STATUS.WAITING,
        seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
      },
      game: null,
      presence: {
        roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        presenceVersion: 1,
        seats: [{ status: state.PRESENCE_STATUS.DISCONNECTED, reconnectDeadlineAt: null }],
      },
    };
    expect<unknown>(state.parseRoomView(view)).toEqual(view);
    expect(() => state.parseRoomView({ ...view, game: {} })).toThrow();
  });
});
