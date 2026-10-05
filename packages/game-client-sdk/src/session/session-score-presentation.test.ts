import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { type GameCommand, parseGameSnapshot, parseRoomView } from '@repo/game-protocol/socket';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { createGameSession } from './session';
import {
  AUTHORITY,
  FakeSocket,
  game,
  NEXT_TURN_ID,
  REQUEST_ID,
  ROOM_ID,
  scoreView,
  syncResponse,
  TURN_ID,
  viewFromGame,
} from './session.test-fixtures';

describe('score and turn session presentation', () => {
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
