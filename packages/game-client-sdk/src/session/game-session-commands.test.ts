import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { type GameCommand } from '@repo/game-protocol/socket';
import { parseRoomView } from '@repo/game-protocol/state';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, jest, test } from 'bun:test';

import { createGameSession } from './game-session';
import {
  AUTHORITY,
  FakeSocket,
  finishedGame,
  game,
  presence,
  ReceiverSocket,
  REQUEST_ID,
  ROLL,
  room,
  ROOM_ID,
  viewFromGame,
} from './game-session.test-fixtures';

describe('game session commands', () => {
  test('preserves the socket receiver and server rejection correlation for commands', async () => {
    const socket = new ReceiverSocket();
    socket.emitSync = socket.emitSync.bind(socket);
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      createActionId: () => ROOM_ID,
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    try {
      expect(await session.connect()).toEqual({ ok: true });
      expect(await session.rollDice()).toEqual({
        ok: false,
        error: {
          kind: 'server',
          error: { code: PUBLIC_ERROR_CODE.NOT_YOUR_TURN, params: {} },
          requestId: REQUEST_ID,
          actionId: ROOM_ID,
        },
      });
      expect(socket.commandCount).toBe(1);
      expect(session.getSnapshot().syncRevision).toBe(2);
    } finally {
      session.dispose();
    }
  });

  test('accepts a finished expired-action recovery view without supplemental sync', async () => {
    const socket = new FakeSocket();
    socket.emitCommand = (command, acknowledge): void =>
      acknowledge({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED, params: {} },
        recovery: viewFromGame(finishedGame(2), 2),
        meta: {
          requestId: REQUEST_ID,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
          actionId: command.actionId,
        },
      });
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => 'de305d54-75b4-431b-adb2-eb6b9e546010',
    });
    await session.connect();

    expect(await session.rollDice()).toMatchObject({
      ok: false,
      error: { kind: 'server', error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED } },
    });
    await Bun.sleep(0);

    expect(socket.syncCount).toBe(1);
    expect(session.getSnapshot()).toMatchObject({
      room: { status: 'finished' },
      game: { stateVersion: 2, match: { status: 'finished' } },
    });
  });

  test.each(['foreign', 'crossed', 'wrong-turn', 'expired-foreign'] as const)(
    'returns INVALID_RESPONSE and bounded full sync for a semantically invalid %s command carrier',
    async (kind) => {
      const socket = new FakeSocket();
      let incoming = viewFromGame(game(2, true));
      if (kind === 'foreign' || kind === 'expired-foreign')
        incoming = parseRoomView({
          ...incoming,
          room: { ...incoming.room, roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ac' },
          presence: { ...incoming.presence, roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ac' },
        });
      if (kind === 'crossed') incoming = viewFromGame(game(2, true), 0);
      if (kind === 'wrong-turn' && incoming.game?.match.status === 'playing')
        incoming = parseRoomView({
          ...incoming,
          game: {
            ...incoming.game,
            match: {
              ...incoming.game.match,
              currentTurn: {
                ...incoming.game.match.currentTurn,
                turnId: '8184fc0a-4e59-455d-a7c1-579a9ee96404',
              },
            },
          },
        });
      socket.emitCommand = (command, acknowledge) =>
        acknowledge({
          ...(kind === 'expired-foreign'
            ? {
                ok: false,
                error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED, params: {} },
                recovery: incoming,
              }
            : { ok: true, data: { receipt: { stateVersion: 2, roll: ROLL }, view: incoming } }),
          meta: {
            requestId: REQUEST_ID,
            gameProtocolVersion: GAME_PROTOCOL_VERSION,
            actionId: command.actionId,
          },
        });
      const session = createGameSession({
        socketUrl: 'https://game.example.test',
        authority: AUTHORITY,
        contract: createCompatibilityContract('release-1'),
        socketFactory: { create: () => socket },
      });
      try {
        await session.connect();
        const baseline = session.getSnapshot();
        expect(await session.rollDice()).toMatchObject({
          ok: false,
          error: { code: 'INVALID_RESPONSE', requestId: REQUEST_ID },
        });
        expect(socket.syncCount).toBe(2);
        expect(session.getSnapshot().game).toEqual(baseline.game);
        expect(session.getSnapshot()).toMatchObject({
          syncRevision: 2,
          presence: { presenceVersion: 1 },
          presentation: { kind: 'settled' },
        });
      } finally {
        session.dispose();
      }
    },
  );

  test('accepts a newer finished view while returning the original older roll receipt', async () => {
    const socket = new FakeSocket();
    socket.emitCommand = (command, acknowledge) =>
      acknowledge({
        ok: true,
        data: { receipt: { stateVersion: 2, roll: ROLL }, view: viewFromGame(finishedGame(5), 3) },
        meta: {
          requestId: REQUEST_ID,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
          actionId: command.actionId,
        },
      });
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    try {
      await session.connect();
      expect(await session.rollDice()).toMatchObject({
        ok: true,
        data: { stateVersion: 2, roll: ROLL },
      });
      expect(session.getSnapshot()).toMatchObject({
        room: { status: 'finished' },
        game: { stateVersion: 5, match: { status: 'finished' } },
        presence: { presenceVersion: 3 },
        presentation: { kind: 'settled' },
      });
      expect(socket.syncCount).toBe(1);
    } finally {
      session.dispose();
    }
  });

  test('replacement during command-state publication ends its result without reviving callbacks', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    try {
      await session.connect();
      session.subscribe(() => {
        if (session.getSnapshot().presentation?.kind === 'roll')
          for (const callback of socket.listeners.replaced) callback();
      });
      expect(await session.rollDice()).toMatchObject({
        ok: false,
        error: { code: 'SESSION_DISPOSED' },
      });
      expect(session.getSnapshot()).toMatchObject({
        connection: 'replaced',
        game: { stateVersion: 2 },
      });
      expect(socket.disposed).toBe(true);
      expect(socket.syncCount).toBe(1);
    } finally {
      session.dispose();
    }
  });

  test.each(['success', 'expired', 'rejected', 'malformed'] as const)(
    'preserves the final snapshot when disposal follows a %s acknowledgement',
    async (kind) => {
      const socket = new FakeSocket();
      let acknowledge!: (value: unknown) => void;
      let sent!: GameCommand;
      socket.emitCommand = (command, nextAcknowledge) => {
        sent = command;
        acknowledge = nextAcknowledge;
      };
      const session = createGameSession({
        socketUrl: 'https://game.example.test',
        authority: AUTHORITY,
        contract: createCompatibilityContract('release-1'),
        socketFactory: { create: () => socket },
      });
      await session.connect();
      let notifications = 0;
      session.subscribe(() => {
        notifications += 1;
      });
      const pending = session.rollDice();
      const meta = {
        requestId: REQUEST_ID,
        gameProtocolVersion: GAME_PROTOCOL_VERSION,
        actionId: sent.actionId,
      };
      const responses = {
        success: {
          ok: true,
          data: { receipt: { stateVersion: 2, roll: ROLL }, view: viewFromGame(game(2, true)) },
          meta,
        },
        expired: {
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED, params: {} },
          recovery: viewFromGame(game(8), 8),
          meta,
        },
        rejected: {
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
          meta,
        },
        malformed: { invalid: true },
      };
      acknowledge(responses[kind]);
      session.dispose();
      const finalSnapshot = session.getSnapshot();

      expect(await pending).toMatchObject({ ok: false, error: { code: 'SESSION_DISPOSED' } });
      expect(session.getSnapshot()).toBe(finalSnapshot);
      expect(session.getSnapshot()).toMatchObject({
        connection: 'disposed',
        game: { stateVersion: 1 },
        presentation: { kind: 'settled' },
      });
      expect(notifications).toBe(0);
      expect(socket.syncCount).toBe(1);
    },
  );

  test('does not expose a command retry when disposed during rejection recovery', async () => {
    const socket = new FakeSocket();
    socket.emitCommand = (command, acknowledge) =>
      acknowledge({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
        meta: {
          requestId: REQUEST_ID,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
          actionId: command.actionId,
        },
      });
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    await session.connect();
    let acknowledgeSync!: (value: unknown) => void;
    socket.syncResponder = (acknowledge) => {
      acknowledgeSync = acknowledge;
    };
    const pending = session.rollDice();
    await Promise.resolve();
    acknowledgeSync({
      ok: true,
      data: { room: room(), game: game(8), presence: presence(8) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    session.dispose();
    const finalSnapshot = session.getSnapshot();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, error: { code: 'SESSION_DISPOSED' } });
    expect(result).not.toHaveProperty('retry');
    expect(session.getSnapshot()).toBe(finalSnapshot);
  });

  test('aborts an in-flight command and clears its acknowledgement timer on dispose', async () => {
    const socket = new FakeSocket();
    socket.emitCommand = () => {};
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 5_000, maximumAttempts: 3, retryDelayMs: 1_000 },
      createActionId: () => 'de305d54-75b4-431b-adb2-eb6b9e546010',
    });
    jest.useFakeTimers();
    try {
      await session.connect();
      const timerBaseline = jest.getTimerCount();

      const pending = session.rollDice();
      expect(jest.getTimerCount()).toBe(timerBaseline + 1);
      session.dispose();
      expect(jest.getTimerCount()).toBe(timerBaseline);

      expect(await pending).toMatchObject({
        ok: false,
        error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
      });
    } finally {
      session.dispose();
      jest.useRealTimers();
    }
  });
});
