import { GAME_PROTOCOL_VERSION as ROOT_GAME_PROTOCOL_VERSION } from '@repo/game-protocol';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomRequest } from '@repo/game-protocol/http';
import { GAME_COMMAND_TYPE } from '@repo/game-protocol/socket';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

describe('package entry points', () => {
  test('resolve every approved subpath through package exports', () => {
    expect(PUBLIC_ERROR_CODE.INVALID_REQUEST).toBe('INVALID_REQUEST');
    expect(GAME_COMMAND_TYPE.ROLL_DICE).toBe('rollDice');
    expect(GAME_PROTOCOL_VERSION).toBe('game-protocol-v16');
    expect(ROOT_GAME_PROTOCOL_VERSION).toBe(GAME_PROTOCOL_VERSION);
    expect(
      parseCreateRoomRequest({
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        operationId: '4ba1e7d4-c077-4b80-b198-9b1f04c182c8',
        profile: { characterId: 'navy-bob', variant: false },
      }),
    ).toBeTruthy();
  });
});
