import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  GAME_COMMAND_TYPE,
  type GameCommand,
  parseGameSnapshot,
  parseResolvedRollArtifact,
  parseRoomView,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, jest, test } from 'bun:test';

import { CLIENT_ERROR_CODE } from '../errors';
import { createCommandRunner } from './command-runner';

const ACTION_ID = 'de305d54-75b4-431b-adb2-eb6b9e546010';
const TURN_ID = 'de305d54-75b4-431b-adb2-eb6b9e546018';
const REQUEST_ID = '9d6ffbb8-10a4-4d43-8c46-cd035b9e87f0';
const META = {
  requestId: REQUEST_ID,
  gameProtocolVersion: GAME_PROTOCOL_VERSION,
  actionId: ACTION_ID,
} as const;
const ROLL = parseResolvedRollArtifact({
  type: 'roll:resolved',
  replay: {
    mode: 'seeded-physics',
    rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
    seed: 'server-seed',
    pourStyle: 'classic',
    rolledSlots: [0],
    contract: createCompatibilityContract('release-1'),
  },
  outcome: { authoritativeValuesBySlot: [{ slot: 0, value: 4 }] },
});

function playingGame(stateVersion = 2, turnId = TURN_ID) {
  return parseGameSnapshot({
    stateVersion,
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
        turnId,
        seatIndex: 0,
        startedAt: 1,
        deadlineAt: 60_001,
        rollCount: 0,
        heldSlots: [],
        dice: null,
      },
    },
  });
}

function successData(receipt: Readonly<{ stateVersion: number; roll?: typeof ROLL }>) {
  const baseline = playingGame(receipt.stateVersion);
  if (baseline.match.status !== 'playing') throw new Error('expected playing fixture');
  const game =
    'roll' in receipt
      ? {
          ...baseline,
          match: {
            ...baseline.match,
            currentTurn: {
              ...baseline.match.currentTurn,
              rollCount: 1,
              dice: Array.from({ length: 5 }, () => ({ value: 4 })),
            },
          },
        }
      : baseline;
  return {
    receipt,
    view: parseRoomView({
      room: {
        status: 'playing',
        roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
        roomCode: '123456',
        createdAt: 1,
        startedAt: 2,
        seats: [
          { profile: { characterId: 'navy-bob', variant: false } },
          { profile: { characterId: 'blonde-buns', variant: false } },
        ],
      },
      game,
      presence: {
        roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
        presenceVersion: 1,
        seats: [{ status: 'connected' }, { status: 'connected' }],
      },
    }),
  };
}

describe('command runner', () => {
  test('retries a byte-equivalent logical command with one actionId', async () => {
    const commands: string[] = [];
    let currentGame = playingGame();
    let attempt = 0;
    let actionIds = 0;
    const runner = createCommandRunner({
      retryPolicy: { acknowledgementTimeoutMs: 2, maximumAttempts: 3, retryDelayMs: 0 },
      createActionId: () => {
        actionIds += 1;
        return ACTION_ID;
      },
      getGame: () => currentGame,
      emit: (command, acknowledge) => {
        commands.push(JSON.stringify(command));
        attempt += 1;
        currentGame = playingGame(3, 'de305d54-75b4-431b-adb2-eb6b9e546099');
        if (attempt === 3) {
          acknowledge({ ok: true, data: successData({ stateVersion: 3, roll: ROLL }), meta: META });
        }
      },
      synchronize: async () => ({ ok: true }),
      applySuccess: () => 'accepted',
      applyRecovery: () => 'accepted',
    });

    const result = await runner.rollDice();

    expect(result).toMatchObject({ ok: true, actionId: ACTION_ID, requestId: REQUEST_ID });
    expect(result).toMatchObject({ data: { stateVersion: 3, roll: ROLL } });
    expect(actionIds).toBe(1);
    expect(commands).toHaveLength(3);
    expect(commands).toEqual([commands[0]!, commands[0]!, commands[0]!]);
    expect(JSON.parse(commands[0]!)).toEqual({
      type: GAME_COMMAND_TYPE.ROLL_DICE,
      actionId: ACTION_ID,
      turnId: TURN_ID,
    });
  });

  test('constructs hold, score, and forfeit commands from semantic calls', async () => {
    const commands: GameCommand[] = [];
    const runner = createCommandRunner({
      retryPolicy: { acknowledgementTimeoutMs: 10, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => ACTION_ID,
      getGame: playingGame,
      emit: (command, acknowledge) => {
        commands.push(command);
        acknowledge({ ok: true, data: successData({ stateVersion: 3 }), meta: META });
      },
      synchronize: async () => ({ ok: true }),
      applySuccess: () => 'accepted',
      applyRecovery: () => 'accepted',
    });

    expect(await runner.setDieHeld(2, true)).toMatchObject({ ok: true });
    expect(await runner.selectScoreCategory('full-house')).toMatchObject({ ok: true });
    expect(await runner.forfeitMatch()).toMatchObject({ ok: true });

    expect(JSON.parse(JSON.stringify(commands))).toEqual([
      { type: 'setDieHeld', actionId: ACTION_ID, turnId: TURN_ID, slot: 2, isHeld: true },
      {
        type: 'selectScoreCategory',
        actionId: ACTION_ID,
        turnId: TURN_ID,
        categoryId: 'full-house',
      },
      { type: 'forfeitMatch', actionId: ACTION_ID },
    ]);
  });

  test('syncs after server rejection and after exhausted acknowledgement timeout', async () => {
    let syncs = 0;
    const failures = [
      {
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.STALE_TURN, params: {} },
        meta: META,
      },
      undefined,
    ];
    const runner = createCommandRunner({
      retryPolicy: { acknowledgementTimeoutMs: 1, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => ACTION_ID,
      getGame: playingGame,
      emit: (_command, acknowledge) => {
        const failure = failures.shift();
        if (failure !== undefined) acknowledge(failure);
      },
      synchronize: async () => {
        syncs += 1;
        return { ok: true };
      },
      applySuccess: () => 'accepted',
      applyRecovery: () => 'accepted',
    });

    const rejected = await runner.rollDice();
    expect(rejected).toMatchObject({ ok: false, error: { kind: 'server' } });
    if (rejected.ok) throw new Error('expected server rejection');
    expect(rejected.retry).toBeUndefined();
    expect(await runner.rollDice()).toMatchObject({
      ok: false,
      error: { kind: 'transport', code: CLIENT_ERROR_CODE.ACK_TIMEOUT },
    });
    expect(syncs).toBe(2);
  });

  test.each(['success', 'failure'] as const)(
    'rejects a contradictory actionId in a %s ACK without applying success and resyncs',
    async (response) => {
      let syncs = 0;
      let successes = 0;
      const runner = createCommandRunner({
        retryPolicy: { acknowledgementTimeoutMs: 10, maximumAttempts: 1, retryDelayMs: 0 },
        createActionId: () => ACTION_ID,
        getGame: playingGame,
        emit: (_command, acknowledge) =>
          acknowledge({
            ...(response === 'success'
              ? { ok: true, data: successData({ stateVersion: 3, roll: ROLL }) }
              : { ok: false, error: { code: PUBLIC_ERROR_CODE.STALE_TURN, params: {} } }),
            meta: { ...META, actionId: 'de305d54-75b4-431b-adb2-eb6b9e546099' },
          }),
        synchronize: async () => {
          syncs += 1;
          return { ok: true };
        },
        applySuccess: () => {
          successes += 1;
          return 'accepted';
        },
        applyRecovery: () => 'accepted',
      });

      expect(await runner.rollDice()).toMatchObject({
        ok: false,
        error: { kind: 'protocol', code: CLIENT_ERROR_CODE.INVALID_RESPONSE },
      });
      expect(syncs).toBe(1);
      expect(successes).toBe(0);
    },
  );

  test.each([
    ['roll', { stateVersion: 3 }],
    ['hold', { stateVersion: 3, roll: ROLL }],
    ['score', { stateVersion: 3, roll: ROLL }],
    ['forfeit', { stateVersion: 3, roll: ROLL }],
  ] as const)('rejects a success payload for the wrong %s command kind', async (kind, data) => {
    let syncs = 0;
    let successes = 0;
    const runner = createCommandRunner({
      retryPolicy: { acknowledgementTimeoutMs: 10, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => ACTION_ID,
      getGame: playingGame,
      emit: (_command, acknowledge) =>
        acknowledge({ ok: true, data: successData(data), meta: META }),
      synchronize: async () => {
        syncs += 1;
        return { ok: true };
      },
      applySuccess: () => {
        successes += 1;
        return 'accepted';
      },
      applyRecovery: () => 'accepted',
    });

    const result = await (kind === 'hold'
      ? runner.setDieHeld(2, true)
      : kind === 'score'
        ? runner.selectScoreCategory('full-house')
        : kind === 'forfeit'
          ? runner.forfeitMatch()
          : runner.rollDice());

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'protocol',
        code: CLIENT_ERROR_CODE.INVALID_RESPONSE,
        actionId: ACTION_ID,
        requestId: REQUEST_ID,
      },
    });
    expect(syncs).toBe(1);
    expect(successes).toBe(0);
  });

  test.each(['roll', 'hold', 'score', 'forfeit'] as const)(
    'coalesces %s INTERNAL_ERROR retries across turn changes',
    async (kind) => {
      let currentGame = playingGame();
      const commands: string[] = [];
      let retryAcknowledge: ((value: unknown) => void) | undefined;
      const runner = createCommandRunner({
        retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
        createActionId: () => ACTION_ID,
        getGame: () => currentGame,
        emit: (command, acknowledge) => {
          commands.push(JSON.stringify(command));
          if (commands.length === 1) {
            acknowledge({
              ok: false,
              error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
              meta: META,
            });
          } else {
            retryAcknowledge = acknowledge;
          }
        },
        synchronize: async () => ({ ok: true }),
        applySuccess: () => 'accepted',
        applyRecovery: () => 'accepted',
      });

      const result = await (kind === 'hold'
        ? runner.setDieHeld(2, true)
        : kind === 'score'
          ? runner.selectScoreCategory('full-house')
          : kind === 'forfeit'
            ? runner.forfeitMatch()
            : runner.rollDice());
      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'server', error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR } },
      });
      if (result.ok || result.retry === undefined) throw new Error('expected retry capability');

      currentGame = playingGame(3, 'de305d54-75b4-431b-adb2-eb6b9e546099');
      expect(result.retry.isAvailable()).toBe(true);
      const first = result.retry.run();
      const repeated = result.retry.run();
      expect(first).toBe(repeated);
      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual(commands[0]);
      retryAcknowledge?.({
        ok: true,
        data: successData({ stateVersion: 3, ...(kind === 'roll' ? { roll: ROLL } : {}) }),
        meta: META,
      });
      expect(await first).toMatchObject({ ok: true, actionId: ACTION_ID });
      expect(result.retry.run()).toBe(first);
      expect(commands).toHaveLength(2);
    },
  );

  test('does not offer internal-error retry when the latest full sync fails', async () => {
    const runner = createCommandRunner({
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => ACTION_ID,
      getGame: playingGame,
      emit: (_command, acknowledge) =>
        acknowledge({
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
          meta: META,
        }),
      synchronize: async () => ({ ok: false }),
      applySuccess: () => 'accepted',
      applyRecovery: () => 'accepted',
    });

    const result = await runner.rollDice();
    if (result.ok) throw new Error('expected command failure');
    expect(result.retry).toBeUndefined();
  });

  test.each([
    ['failed sync', { ok: false } as const, playingGame(2), false],
    ['advanced state', { ok: true } as const, playingGame(3), false],
    [
      'changed turn',
      { ok: true } as const,
      playingGame(2, 'de305d54-75b4-431b-adb2-eb6b9e546099'),
      false,
    ],
    ['current state and turn', { ok: true } as const, playingGame(2), true],
  ])(
    'gates roll-unavailable retry on post-sync command currency: %s',
    async (_case, syncResult, synchronizedGame, retryable) => {
      let currentGame = playingGame(2);
      const runner = createCommandRunner({
        retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
        createActionId: () => ACTION_ID,
        getGame: () => currentGame,
        emit: (_command, acknowledge) =>
          acknowledge({
            ok: false,
            error: { code: PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE, params: {} },
            meta: META,
          }),
        synchronize: async () => {
          currentGame = synchronizedGame;
          return syncResult;
        },
        applySuccess: () => 'accepted',
        applyRecovery: () => 'accepted',
      });

      const result = await runner.rollDice();
      if (result.ok) throw new Error('expected command failure');
      expect(result.retry === undefined).toBe(!retryable);
      if (result.retry) {
        expect(result.retry.isAvailable()).toBe(true);
        const retried = result.retry.run();
        expect(retried).not.toBeNull();
        expect(result.retry.run()).toBe(retried);
        await retried;
      }
    },
  );

  test.each([
    ['state version', playingGame(3)],
    ['turn', playingGame(2, 'de305d54-75b4-431b-adb2-eb6b9e546099')],
  ])('expires an offered roll retry after a later %s change', async (_case, nextGame) => {
    let currentGame = playingGame();
    let emits = 0;
    const runner = createCommandRunner({
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => ACTION_ID,
      getGame: () => currentGame,
      emit: (_command, acknowledge) => {
        emits += 1;
        acknowledge({
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE, params: {} },
          meta: META,
        });
      },
      synchronize: async () => ({ ok: true }),
      applySuccess: () => 'accepted',
      applyRecovery: () => 'accepted',
    });
    const result = await runner.rollDice();
    if (result.ok || !result.retry) throw new Error('expected retry capability');
    expect(result.retry.isAvailable()).toBe(true);
    currentGame = nextGame;
    expect(result.retry.run()).toBeNull();
    expect(result.retry.isAvailable()).toBe(false);
    expect(emits).toBe(1);
  });

  test('never offers a manual retry after exhausted acknowledgement loss', async () => {
    let currentGame = playingGame(2);
    const runner = createCommandRunner({
      retryPolicy: { acknowledgementTimeoutMs: 1, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => ACTION_ID,
      getGame: () => currentGame,
      emit: () => {},
      synchronize: async () => {
        currentGame = playingGame(3);
        return { ok: true };
      },
      applySuccess: () => 'accepted',
      applyRecovery: () => 'accepted',
    });

    const result = await runner.rollDice();
    expect(result).toMatchObject({
      ok: false,
      error: { kind: 'transport', code: CLIENT_ERROR_CODE.ACK_TIMEOUT },
    });
    if (result.ok) throw new Error('expected command failure');
    expect(result.retry).toBeUndefined();
  });

  test('a retry capability becomes inert when its owning session lifecycle is disposed', async () => {
    const lifecycle = new AbortController();
    let emits = 0;
    const runner = createCommandRunner({
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => ACTION_ID,
      getGame: playingGame,
      emit: (_command, acknowledge) => {
        emits += 1;
        acknowledge({
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
          meta: META,
        });
      },
      synchronize: async () => ({ ok: true }),
      applySuccess: () => 'accepted',
      applyRecovery: () => 'accepted',
      signal: lifecycle.signal,
    });

    const result = await runner.rollDice();
    if (result.ok || result.retry === undefined) throw new Error('expected retry capability');
    lifecycle.abort();

    expect(result.retry.isAvailable()).toBe(false);
    expect(result.retry.run()).toBeNull();
    expect(emits).toBe(1);
  });

  test('cancels a pending retry delay without another emit', async () => {
    const lifecycle = new AbortController();
    let emits = 0;
    const runner = createCommandRunner({
      retryPolicy: { acknowledgementTimeoutMs: 1, maximumAttempts: 3, retryDelayMs: 5_000 },
      createActionId: () => ACTION_ID,
      getGame: playingGame,
      emit: () => {
        emits += 1;
      },
      synchronize: async () => ({ ok: true }),
      applySuccess: () => 'accepted',
      applyRecovery: () => 'accepted',
      signal: lifecycle.signal,
    });

    jest.useFakeTimers();
    try {
      const pending = runner.rollDice();
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      jest.advanceTimersByTime(4_999);
      await Promise.resolve();
      expect(emits).toBe(1);
      lifecycle.abort();

      expect(await pending).toMatchObject({
        ok: false,
        error: { kind: 'protocol', code: CLIENT_ERROR_CODE.SESSION_DISPOSED },
      });
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      expect(emits).toBe(1);
    } finally {
      lifecycle.abort();
      jest.useRealTimers();
    }
  });
});
