import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { type GameCommand } from '@repo/game-protocol/socket';
import { parseGameSnapshot, parseRoomView } from '@repo/game-protocol/state';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { createGameSession } from './game-session';
import {
  AUTHORITY,
  FakeSocket,
  game,
  NEXT_TURN_ID,
  presence,
  REQUEST_ID,
  ROLL,
  room,
  ROOM_ID,
  scoreView,
  syncResponse,
  TURN_ID,
  viewFromGame,
} from './game-session.test-fixtures';

describe('game session presentation', () => {
  test.each([
    { synchronizedVersion: 2, acknowledgementVersion: 1, presentsRoll: false },
    { synchronizedVersion: 1, acknowledgementVersion: 1, presentsRoll: false },
    { synchronizedVersion: 0, acknowledgementVersion: 1, presentsRoll: true },
  ])(
    'orders a delayed roll acknowledgement against recovered state %j',
    async ({ synchronizedVersion, acknowledgementVersion, presentsRoll }) => {
      const socket = new FakeSocket();
      socket.syncVersion = 0;
      let sent!: GameCommand;
      let acknowledge!: (value: unknown) => void;
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
      const pending = session.rollDice();
      session.disconnect();
      socket.syncVersion = synchronizedVersion;
      const baseline = game(synchronizedVersion);
      if (baseline.match.status !== 'playing') throw new Error('expected playing fixture');
      const recoveredGame = parseGameSnapshot({
        ...baseline,
        match: {
          ...baseline.match,
          currentTurn:
            synchronizedVersion > acknowledgementVersion
              ? {
                  ...baseline.match.currentTurn,
                  turnId: '8184fc0a-4e59-455d-a7c1-579a9ee96404',
                  seatIndex: 1,
                }
              : synchronizedVersion === acknowledgementVersion
                ? {
                    ...baseline.match.currentTurn,
                    rollCount: 1,
                    dice: [4, 1, 2, 3, 5].map((value) => ({ value })),
                  }
                : baseline.match.currentTurn,
        },
      });
      socket.syncResponder = (respond) =>
        respond({
          ok: true,
          data: { room: room(), game: recoveredGame, presence: presence(synchronizedVersion) },
          meta: {
            requestId: REQUEST_ID,
            serverTime: 1000,
            gameProtocolVersion: GAME_PROTOCOL_VERSION,
          },
        });
      await session.connect();
      const recovered = session.getSnapshot();
      let notifications = 0;
      session.subscribe(() => {
        notifications += 1;
      });

      acknowledge({
        ok: true,
        data: {
          receipt: { stateVersion: acknowledgementVersion, roll: ROLL },
          view: viewFromGame(
            synchronizedVersion > acknowledgementVersion
              ? recoveredGame
              : game(acknowledgementVersion, true),
            synchronizedVersion,
          ),
        },
        meta: {
          requestId: REQUEST_ID,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
          actionId: sent.actionId,
        },
      });
      expect(await pending).toMatchObject({
        ok: true,
        data: { stateVersion: acknowledgementVersion, roll: ROLL },
      });
      expect(Number(session.getSnapshot().game?.stateVersion)).toBe(
        Math.max(synchronizedVersion, acknowledgementVersion),
      );
      const { presentation } = session.getSnapshot();
      expect(presentation?.kind === 'roll' ? presentation.roll.replay.rollId : null).toBe(
        presentsRoll ? ROLL.replay.rollId : null,
      );
      expect(notifications).toBe(presentsRoll ? 1 : 0);
      if (!presentsRoll) expect(session.getSnapshot()).toBe(recovered);
      session.dispose();
    },
  );

  test('applies a resolved roll returned by an opaque command retry', async () => {
    const socket = new FakeSocket();
    let commands = 0;
    socket.emitCommand = (command, acknowledge): void => {
      commands += 1;
      acknowledge(
        commands === 1
          ? {
              ok: false,
              error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
              meta: {
                requestId: REQUEST_ID,
                gameProtocolVersion: GAME_PROTOCOL_VERSION,
                actionId: command.actionId,
              },
            }
          : {
              ok: true,
              data: { receipt: { stateVersion: 2, roll: ROLL }, view: viewFromGame(game(2, true)) },
              meta: {
                requestId: REQUEST_ID,
                gameProtocolVersion: GAME_PROTOCOL_VERSION,
                actionId: command.actionId,
              },
            },
      );
    };
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => 'de305d54-75b4-431b-adb2-eb6b9e546010',
    });
    await session.connect();

    const failed = await session.rollDice();
    if (failed.ok || failed.retry === undefined) throw new Error('expected retry capability');
    const retried = await failed.retry.run();
    expect(retried).toMatchObject({ ok: true });
    if (!retried?.ok || !('roll' in retried.data)) throw new Error('expected retried roll');

    expect(session.getSnapshot()).toMatchObject({
      game: { stateVersion: 2 },
      presentation: { kind: 'roll', roll: retried.data.roll },
    });
  });

  test.each(['live-first', 'ACK-first'] as const)(
    'presents a fresh roll once when %s carries the complete view',
    async (order) => {
      const socket = new FakeSocket();
      let acknowledge!: (value: unknown) => void;
      let command!: GameCommand;
      socket.emitCommand = (sent, reply) => {
        command = sent;
        acknowledge = reply;
      };
      const session = createGameSession({
        socketUrl: 'https://game.example.test',
        authority: AUTHORITY,
        contract: createCompatibilityContract('release-1'),
        socketFactory: { create: () => socket },
      });
      try {
        await session.connect();
        let notifications = 0;
        session.subscribe(() => {
          notifications += 1;
        });
        const pending = session.rollDice();
        const committedView = viewFromGame(game(2, true));
        const broadcast = () => {
          for (const listener of socket.listeners.roomUpdate)
            listener({ type: 'roll:committed', view: committedView, roll: ROLL });
        };
        const reply = () =>
          acknowledge({
            ok: true,
            data: { receipt: { stateVersion: 2, roll: ROLL }, view: committedView },
            meta: {
              requestId: REQUEST_ID,
              gameProtocolVersion: GAME_PROTOCOL_VERSION,
              actionId: command.actionId,
            },
          });
        if (order === 'live-first') broadcast();
        else {
          reply();
          await Promise.resolve();
        }
        const firstPresentation = session.getSnapshot().presentation;
        expect(session.getSnapshot().game).toMatchObject({
          stateVersion: 2,
          match: { currentTurn: { turnId: TURN_ID } },
        });
        expect(firstPresentation).toMatchObject({
          kind: 'roll',
          roll: ROLL,
        });
        if (order === 'live-first') reply();
        else broadcast();
        expect(await pending).toMatchObject({
          ok: true,
          data: { stateVersion: 2, roll: ROLL },
          actionId: command.actionId,
        });
        broadcast();
        expect(session.getSnapshot().presentation).toBe(firstPresentation);
        expect(notifications).toBe(1);
        expect(socket.syncCount).toBe(1);
      } finally {
        session.dispose();
      }
    },
  );

  test('settles a roll gap, then presents the next fresh roll without supplemental sync', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    try {
      await session.connect();
      const jump = viewFromGame(game(5, true));
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'roll:committed', view: jump, roll: ROLL });
      expect(session.getSnapshot()).toMatchObject({
        game: { stateVersion: 5 },
        presentation: { kind: 'settled' },
      });
      const nextRoll = {
        ...ROLL,
        replay: { ...ROLL.replay, rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96404' },
      };
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'roll:committed', view: viewFromGame(game(6, true)), roll: nextRoll });
      expect(session.getSnapshot()).toMatchObject({
        game: { stateVersion: 6 },
        presentation: { kind: 'roll', roll: nextRoll },
      });
      expect(socket.syncCount).toBe(1);
    } finally {
      session.dispose();
    }
  });

  test('presence-only views preserve a fresh roll and an original-turn roll retry', async () => {
    const socket = new FakeSocket();
    socket.emitCommand = (command, acknowledge) =>
      acknowledge({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE, params: {} },
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
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'roll:committed', view: viewFromGame(game(2, true)), roll: ROLL });
      const fresh = session.getSnapshot().presentation;
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'state:committed', view: viewFromGame(game(2, true), 2) });
      expect(session.getSnapshot().presentation).toBe(fresh);
      socket.syncResponder = (acknowledge) =>
        acknowledge({
          ok: true,
          data: viewFromGame(game(2, true), 2),
          meta: {
            requestId: REQUEST_ID,
            serverTime: 1000,
            gameProtocolVersion: GAME_PROTOCOL_VERSION,
          },
        });
      const rejected = await session.rollDice();
      if (rejected.ok || !rejected.retry) throw new Error('expected original roll retry');
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'state:committed', view: viewFromGame(game(2, true), 3) });
      expect(rejected.retry.isAvailable()).toBe(true);
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'state:committed', view: viewFromGame(game(3, true), 3) });
      expect(rejected.retry.isAvailable()).toBe(false);
      expect(rejected.retry.run()).toBeNull();
    } finally {
      session.dispose();
    }
  });

  test('accepts a first live roll as settled before authentication full sync completes', async () => {
    const socket = new FakeSocket();
    let acknowledge!: (value: unknown) => void;
    socket.syncResponder = (reply) => {
      acknowledge = reply;
    };
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    try {
      const connected = session.connect();
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'roll:committed', view: viewFromGame(game(2, true)), roll: ROLL });
      expect(session.getSnapshot()).toMatchObject({
        syncRevision: 0,
        game: { stateVersion: 2 },
        presentation: { kind: 'settled' },
      });
      acknowledge({
        ok: true,
        data: viewFromGame(game(1)),
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
      expect(await connected).toEqual({ ok: true });
      expect(session.getSnapshot()).toMatchObject({
        syncRevision: 1,
        game: { stateVersion: 2 },
        presentation: { kind: 'settled' },
      });
      expect(socket.syncCount).toBe(1);
    } finally {
      session.dispose();
    }
  });

  test.each([
    { version: 1, kind: 'roll' },
    { version: 2, kind: 'settled' },
    { version: 3, kind: 'settled' },
  ] as const)(
    'expired recovery version $version keeps $kind presentation without completing full-sync confirmation',
    async ({ version, kind }) => {
      const socket = new FakeSocket();
      socket.emitCommand = (command, acknowledge) =>
        acknowledge({
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED, params: {} },
          recovery: viewFromGame(game(version, version >= 2), 2),
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
        for (const listener of socket.listeners.roomUpdate)
          listener({ type: 'roll:committed', view: viewFromGame(game(2, true), 2), roll: ROLL });
        const fresh = session.getSnapshot().presentation;
        expect(await session.rollDice()).toMatchObject({
          ok: false,
          error: { error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED } },
        });
        expect(session.getSnapshot()).toMatchObject({
          syncRevision: 1,
          game: { stateVersion: Math.max(2, version) },
          presentation: { kind },
        });
        if (kind === 'roll') expect(session.getSnapshot().presentation).toBe(fresh);
        expect(socket.syncCount).toBe(1);
      } finally {
        session.dispose();
      }
    },
  );

  test.each([
    { order: 'live-first', final: false },
    { order: 'ACK-first', final: false },
    { order: 'live-first', final: true },
    { order: 'ACK-first', final: true },
  ] as const)(
    'publishes one zero-score record for $order, final=$final',
    async ({ order, final }) => {
      const socket = new FakeSocket();
      let acknowledge!: (value: unknown) => void;
      let command!: GameCommand;
      socket.emitCommand = (sent, reply) => {
        command = sent;
        acknowledge = reply;
      };
      const session = createGameSession({
        socketUrl: 'https://game.example.test',
        authority: AUTHORITY,
        contract: createCompatibilityContract('release-1'),
        socketFactory: { create: () => socket },
      });
      try {
        await session.connect();
        let publications = 0;
        session.subscribe(() => {
          publications += 1;
        });
        const pending = session.selectScoreCategory('ones');
        const incoming = scoreView(2, final);
        const broadcast = () => {
          for (const listener of socket.listeners.roomUpdate)
            listener({ type: 'state:committed', view: incoming });
        };
        const reply = () =>
          acknowledge({
            ok: true,
            data: { receipt: { stateVersion: 2 }, view: incoming },
            meta: {
              requestId: REQUEST_ID,
              gameProtocolVersion: GAME_PROTOCOL_VERSION,
              actionId: command.actionId,
            },
          });
        if (order === 'live-first') broadcast();
        else {
          reply();
          await Promise.resolve();
        }
        const first = session.getSnapshot().presentation;
        expect(first).toMatchObject({
          kind: 'score',
          record: {
            stateVersion: 2,
            completedTurnId: TURN_ID,
            seatIndex: 0,
            categoryId: 'ones',
            score: 0,
          },
        });
        expect(session.getSnapshot().game?.match.status).toBe(final ? 'finished' : 'playing');
        if (order === 'live-first') reply();
        else broadcast();
        expect(await pending).toMatchObject({ ok: true, data: { stateVersion: 2 } });
        broadcast();
        expect(publications).toBe(1);
        expect(session.getSnapshot().presentation).toBe(first);
        const presenceOnly = parseRoomView({
          ...incoming,
          presence: { ...incoming.presence, presenceVersion: 2 },
        });
        for (const listener of socket.listeners.roomUpdate)
          listener({ type: 'state:committed', view: presenceOnly });
        expect(session.getSnapshot().presentation).toBe(first);
        expect(socket.syncCount).toBe(1);
      } finally {
        session.dispose();
      }
    },
  );

  test.each([3, 5])(
    'a late original score receipt does not present the opponent record in view version %s',
    async (stateVersion) => {
      const socket = new FakeSocket();
      let acknowledge!: (value: unknown) => void;
      let command!: GameCommand;
      socket.emitCommand = (sent, reply) => {
        command = sent;
        acknowledge = reply;
      };
      const session = createGameSession({
        socketUrl: 'https://game.example.test',
        authority: AUTHORITY,
        contract: createCompatibilityContract('release-1'),
        socketFactory: { create: () => socket },
      });
      try {
        await session.connect();
        const pending = session.selectScoreCategory('ones');
        const first = scoreView();
        for (const listener of socket.listeners.roomUpdate)
          listener({ type: 'state:committed', view: first });
        expect(session.getSnapshot().presentation?.kind).toBe('score');
        const previous = first.game;
        if (previous?.match.status !== 'playing') throw new Error('expected playing fixture');
        const newer = viewFromGame(
          parseGameSnapshot({
            stateVersion,
            match: {
              ...previous.match,
              players: [previous.match.players[0], { scorecard: { twos: 0 }, timeoutCount: 0 }],
              currentTurn: { ...previous.match.currentTurn, turnId: TURN_ID, seatIndex: 0 },
            },
          }),
        );
        acknowledge({
          ok: true,
          data: { receipt: { stateVersion: 2 }, view: newer },
          meta: {
            requestId: REQUEST_ID,
            gameProtocolVersion: GAME_PROTOCOL_VERSION,
            actionId: command.actionId,
          },
        });
        expect(await pending).toMatchObject({
          ok: true,
          data: { stateVersion: 2 },
        });
        expect(session.getSnapshot()).toMatchObject({
          game: { stateVersion },
          presentation: { kind: 'settled' },
        });
        expect(socket.syncCount).toBe(1);
      } finally {
        session.dispose();
      }
    },
  );

  test.each(['expired', 'rejected', 'ACK-timeout'] as const)(
    '%s recovery accepts score authority without a success presentation',
    async (recovery) => {
      const socket = new FakeSocket();
      const incoming = scoreView();
      socket.emitCommand = (command, acknowledge) => {
        if (recovery === 'ACK-timeout') return;
        acknowledge({
          ok: false,
          error: {
            code:
              recovery === 'expired'
                ? PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED
                : PUBLIC_ERROR_CODE.INTERNAL_ERROR,
            params: {},
          },
          ...(recovery === 'expired' ? { recovery: incoming } : {}),
          meta: {
            requestId: REQUEST_ID,
            gameProtocolVersion: GAME_PROTOCOL_VERSION,
            actionId: command.actionId,
          },
        });
      };
      const session = createGameSession({
        socketUrl: 'https://game.example.test',
        authority: AUTHORITY,
        contract: createCompatibilityContract('release-1'),
        socketFactory: { create: () => socket },
        retryPolicy: { acknowledgementTimeoutMs: 10, maximumAttempts: 1, retryDelayMs: 0 },
      });
      try {
        await session.connect();
        socket.syncResponder = (reply) => reply(syncResponse(incoming));
        const observed: string[] = [];
        session.subscribe(() => {
          observed.push(session.getSnapshot().presentation?.kind ?? 'none');
        });
        expect(await session.selectScoreCategory('ones')).toMatchObject({ ok: false });
        expect(session.getSnapshot()).toMatchObject({
          game: { stateVersion: 2 },
          presentation: { kind: 'settled' },
        });
        expect(observed).not.toContain('score');
        expect(observed).not.toContain('turn');
        expect(socket.syncCount).toBe(recovery === 'expired' ? 1 : 2);
      } finally {
        session.dispose();
      }
    },
  );

  test.each(['score', 'turn'] as const)(
    'older in-flight sync preserves %s; same-version sync settles it',
    async (kind) => {
      const socket = new FakeSocket();
      const baseline = game(2);
      if (baseline.match.status !== 'playing') throw new Error('expected playing fixture');
      const incoming =
        kind === 'score'
          ? scoreView()
          : viewFromGame(
              parseGameSnapshot({
                ...baseline,
                match: {
                  ...baseline.match,
                  players: [
                    { ...baseline.match.players[0], timeoutCount: 1 },
                    baseline.match.players[1],
                  ],
                  currentTurn: {
                    ...baseline.match.currentTurn,
                    turnId: NEXT_TURN_ID,
                    seatIndex: 1,
                  },
                },
              }),
            );
      const session = createGameSession({
        socketUrl: 'https://game.example.test',
        authority: AUTHORITY,
        contract: createCompatibilityContract('release-1'),
        socketFactory: { create: () => socket },
      });
      try {
        await session.connect();
        let acknowledge!: (value: unknown) => void;
        socket.syncResponder = (reply) => {
          acknowledge = reply;
        };
        const older = session.synchronize();
        for (const listener of socket.listeners.roomUpdate)
          listener({ type: 'state:committed', view: incoming });
        const fresh = session.getSnapshot().presentation;
        expect(fresh?.kind).toBe(kind);
        acknowledge(syncResponse(viewFromGame(game(1))));
        expect(await older).toEqual({ ok: true });
        expect(session.getSnapshot().presentation).toBe(fresh);
        const current = session.synchronize();
        acknowledge(syncResponse(incoming));
        expect(await current).toEqual({ ok: true });
        expect(session.getSnapshot()).toMatchObject({
          game: { stateVersion: 2 },
          presentation: { kind: 'settled' },
          syncRevision: 3,
        });
      } finally {
        session.dispose();
      }
    },
  );

  test('known waiting to playing yields a turn, while an initial playing sync remains settled', async () => {
    const socket = new FakeSocket();
    const waiting = parseRoomView({
      room: {
        status: 'waiting',
        roomId: ROOM_ID,
        roomCode: '123456',
        createdAt: 1,
        expiresAt: 301000,
        seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
      },
      game: null,
      presence: { roomId: ROOM_ID, presenceVersion: 0, seats: [{ status: 'connected' }] },
    });
    socket.syncResponder = (reply) => reply(syncResponse(waiting));
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    try {
      await session.connect();
      expect(session.getSnapshot().presentation).toBeNull();
      const incoming = viewFromGame(game(1));
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'state:committed', view: incoming });
      expect(session.getSnapshot().presentation).toMatchObject({ kind: 'turn', turnId: TURN_ID });
      socket.syncResponder = (reply) => reply(syncResponse(incoming));
      expect(await session.synchronize()).toEqual({ ok: true });
      expect(session.getSnapshot().presentation).toEqual({ kind: 'settled' });
    } finally {
      session.dispose();
    }
    const baselineSession = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => new FakeSocket() },
    });
    try {
      await baselineSession.connect();
      expect(baselineSession.getSnapshot().presentation).toEqual({ kind: 'settled' });
    } finally {
      baselineSession.dispose();
    }
  });
});
