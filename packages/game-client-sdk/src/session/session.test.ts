import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  type GameCommand,
  parseGameSnapshot,
  parseRoomView,
  parseSocketAuth,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, jest, test } from 'bun:test';

import type { GameSocketFactory, RawGameSocket } from '../ports';
import { createServerClock } from '../server-clock';
import { createGameSession } from './session';
import {
  AUTHORITY,
  FakeSocket,
  finishedGame,
  game,
  presence,
  REQUEST_ID,
  ROLL,
  room,
  ROOM_ID,
  SEAT_TOKEN,
  syncResponse,
  TURN_ID,
  viewFromGame,
} from './session.test-fixtures';

class ReceiverSocket implements RawGameSocket {
  readonly #transport = new FakeSocket();
  #syncs = 0;
  #commands = 0;

  public readonly connect = this.#transport.connect;
  public readonly disconnect = this.#transport.disconnect;
  public readonly dispose = this.#transport.dispose;
  public readonly onConnected = this.#transport.onConnected;
  public readonly onConnectionError = this.#transport.onConnectionError;
  public readonly onDisconnected = this.#transport.onDisconnected;
  public readonly onReplaced = this.#transport.onReplaced;
  public readonly onRoomUpdate = this.#transport.onRoomUpdate;

  public get syncCount(): number {
    return this.#syncs;
  }

  public get commandCount(): number {
    return this.#commands;
  }

  public emitSync(acknowledge: (value: unknown) => void): void {
    this.#syncs += 1;
    acknowledge(syncResponse(viewFromGame(game(1))));
  }

  public emitCommand(command: GameCommand, acknowledge: (value: unknown) => void): void {
    this.#commands += 1;
    acknowledge({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.NOT_YOUR_TURN, params: {} },
      meta: {
        requestId: REQUEST_ID,
        actionId: command.actionId,
        gameProtocolVersion: GAME_PROTOCOL_VERSION,
      },
    });
  }
}

describe('game session', () => {
  test('preserves the socket receiver during initial and explicit synchronization', async () => {
    const socket = new ReceiverSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    try {
      expect(await session.connect()).toEqual({ ok: true });
      expect(socket.syncCount).toBe(1);
      expect(session.getSnapshot().syncRevision).toBe(1);
      expect(await session.synchronize()).toEqual({ ok: true });
      expect(socket.syncCount).toBe(2);
      expect(session.getSnapshot().syncRevision).toBe(2);
      expect(session.getSnapshot().game).toEqual(game(1));
    } finally {
      session.dispose();
    }
  });

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

  test('replacement ends pending work and cannot be revived by late callbacks or reconnect', async () => {
    const socket = new FakeSocket();
    let acknowledgeSync!: (value: unknown) => void;
    let acknowledgeCommand!: (value: unknown) => void;
    let commandCount = 0;
    socket.emitCommand = (_command, acknowledge) => {
      commandCount += 1;
      acknowledgeCommand = acknowledge;
    };
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 3, retryDelayMs: 0 },
    });
    await session.connect();
    socket.syncResponder = (acknowledge) => {
      acknowledgeSync = acknowledge;
    };

    const lateConnected = [...socket.listeners.connected];
    const lateDisconnected = [...socket.listeners.disconnected];
    const observed: string[] = [];
    session.subscribe(() => observed.push(session.getSnapshot().connection));
    const syncing = session.synchronize();
    const command = session.rollDice();
    for (const callback of socket.listeners.replaced) callback();
    const terminal = session.getSnapshot();
    expect(terminal.connection).toBe('replaced');
    expect(observed.at(-1)).toBe('replaced');
    expect(socket.disposed).toBe(true);
    expect(await syncing).toMatchObject({ ok: false, error: { code: 'SESSION_DISPOSED' } });
    expect(await command).toMatchObject({ ok: false, error: { code: 'SESSION_DISPOSED' } });
    acknowledgeSync({
      ok: true,
      data: { room: room(), game: game(8), presence: presence(8) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    acknowledgeCommand({ invalid: true });
    for (const callback of [...lateConnected, ...lateDisconnected]) callback();
    expect(await session.connect()).toMatchObject({ ok: false });
    expect(await session.synchronize()).toMatchObject({ ok: false });
    expect(await session.rollDice()).toMatchObject({ ok: false });
    session.disconnect();
    await Bun.sleep(30);
    expect(session.getSnapshot()).toBe(terminal);
    expect(commandCount).toBe(1);
    expect(socket.syncCount).toBe(2);
    session.dispose();
  });

  test('does not open transport when a connecting subscriber ends the session', async () => {
    const socket = new FakeSocket();
    let connectCount = 0;
    socket.connect = async () => {
      connectCount += 1;
    };
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    session.subscribe(() => {
      if (session.getSnapshot().connection === 'connecting') {
        for (const callback of socket.listeners.replaced) callback();
      }
    });
    expect(await session.connect()).toMatchObject({ ok: false });
    expect(session.getSnapshot().connection).toBe('replaced');
    expect(connectCount).toBe(0);
    session.dispose();
  });

  test('replacement settles authentication and invalidates an offered retry', async () => {
    const connectingSocket = new FakeSocket();
    connectingSocket.connect = () => new Promise(() => {});
    const connectingSession = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => connectingSocket },
    });
    const connecting = connectingSession.connect();
    for (const callback of connectingSocket.listeners.replaced) callback();
    expect(await connecting).toMatchObject({ ok: false, error: { code: 'SESSION_DISPOSED' } });
    expect(connectingSession.getSnapshot().connection).toBe('replaced');
    expect(connectingSocket.syncCount).toBe(0);
    connectingSession.dispose();

    const socket = new FakeSocket();
    let commandCount = 0;
    socket.emitCommand = (command, acknowledge) => {
      commandCount += 1;
      acknowledge({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
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
    });
    await session.connect();
    const result = await session.rollDice();
    if (result.ok || !result.retry) throw new Error('expected retry capability');
    expect(result.retry.isAvailable()).toBe(true);
    for (const callback of socket.listeners.replaced) callback();
    expect(result.retry.isAvailable()).toBe(false);
    expect(result.retry.run()).toBeNull();
    expect(commandCount).toBe(1);
    session.dispose();
  });

  test('applies a jump immediately and coalesces explicit full-sync confirmations', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    const observedSyncLifecycle: Array<{
      connection: string;
      syncStatus: string;
      syncRevision: number;
    }> = [];
    session.subscribe(() => {
      const { connection, syncStatus, syncRevision } = session.getSnapshot();
      observedSyncLifecycle.push({ connection, syncStatus, syncRevision });
    });

    expect(session.getSnapshot()).toMatchObject({
      room: null,
      syncStatus: 'idle',
      syncRevision: 0,
    });
    await session.connect();
    expect(session.getSnapshot()).toMatchObject({
      room: {
        status: 'playing',
        seats: [
          { profile: { characterId: 'navy-bob', variant: false } },
          { profile: { characterId: 'blonde-buns', variant: false } },
        ],
      },
      syncStatus: 'idle',
      syncRevision: 1,
    });
    expect(observedSyncLifecycle).not.toContainEqual({
      connection: 'connected',
      syncStatus: 'idle',
      syncRevision: 0,
    });

    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (nextAcknowledge): void => {
      acknowledge = nextAcknowledge;
    };
    socket.syncVersion = 5;
    for (const listener of socket.listeners.roomUpdate) {
      listener({ type: 'state:committed', view: viewFromGame(game(5)) });
    }
    const external = session.synchronize();
    const coalescedExternal = session.synchronize();

    expect(socket.syncCount).toBe(2);
    expect(session.getSnapshot()).toMatchObject({
      syncStatus: 'synchronizing',
      syncRevision: 1,
      game: { stateVersion: 5 },
    });

    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(5), presence: presence(5) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    expect(await Promise.all([external, coalescedExternal])).toEqual([{ ok: true }, { ok: true }]);
    expect(session.getSnapshot()).toMatchObject({
      syncStatus: 'idle',
      syncRevision: 2,
      game: { stateVersion: 5 },
      presence: { presenceVersion: 5 },
    });
  });

  test('ignores an older full view without regressing authority or a newer clock sample', async () => {
    const socket = new FakeSocket();
    let now = 0;
    const clock = createServerClock(() => now);
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      clock,
    });
    await session.connect();
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (next) => {
      acknowledge = next;
    };
    now = 100;
    const pending = session.synchronize();
    for (const listener of socket.listeners.roomUpdate) {
      listener({ type: 'state:committed', view: viewFromGame(game(5), 2) });
    }
    now = 110;
    const newerSample = clock.beginSample();
    now = 120;
    clock.acceptSample(newerSample, 2000);
    const completed: unknown[] = [];
    session.subscribe(() => {
      const current = session.getSnapshot();
      if (current.syncStatus === 'idle') {
        completed.push({
          version: current.game?.stateVersion,
          revision: current.syncRevision,
          time: clock.now(),
        });
      }
    });
    now = 140;
    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(1), presence: presence(2) },
      meta: { requestId: REQUEST_ID, serverTime: 1500, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    expect(await pending).toEqual({ ok: true });
    expect(completed).toEqual([{ version: 5, revision: 2, time: 2025 }]);
    expect(Number(session.getSnapshot().presence?.presenceVersion)).toBe(2);
    session.dispose();
  });

  test('rejects coherent snapshots for another room before changing state or the clock', async () => {
    const socket = new FakeSocket();
    const clock = createServerClock(() => 0);
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      clock,
    });
    await session.connect();
    const foreignRoomId = '01890f47-e89b-7cc3-98c5-4c5da03f78ac';
    socket.syncResponder = (acknowledge) =>
      acknowledge({
        ok: true,
        data: {
          room: { ...room(), roomId: foreignRoomId },
          game: game(8),
          presence: { ...presence(8), roomId: foreignRoomId },
        },
        meta: {
          requestId: REQUEST_ID,
          serverTime: 9000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
    expect(await session.synchronize()).toMatchObject({
      ok: false,
      error: { code: 'INVALID_RESPONSE', requestId: REQUEST_ID },
    });
    expect(session.getSnapshot()).toMatchObject({
      syncRevision: 1,
      game: { stateVersion: 1 },
      presence: { presenceVersion: 1 },
    });
    expect(clock.now()).toBe(1000);
    session.dispose();
  });

  test('publishes a waiting room and its clock sample together after authentication', async () => {
    const socket = new FakeSocket();
    let now = 10;
    const clock = createServerClock(() => now);
    socket.syncResponder = (acknowledge) => {
      now = 30;
      acknowledge({
        ok: true,
        data: {
          room: {
            status: 'waiting',
            roomId: ROOM_ID,
            roomCode: '123456',
            createdAt: 1,
            expiresAt: 301000,
            seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
          },
          game: null,
          presence: { roomId: ROOM_ID, presenceVersion: 1, seats: [{ status: 'connected' }] },
        },
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
    };
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      clock,
    });
    const completed: unknown[] = [];
    session.subscribe(() => {
      const current = session.getSnapshot();
      if (current.syncRevision > 0)
        completed.push({
          room: current.room?.status,
          game: current.game,
          presence: current.presence?.presenceVersion,
          time: clock.now(),
          status: current.syncStatus,
        });
    });
    expect(await session.connect()).toEqual({ ok: true });
    expect(completed).toEqual([
      { room: 'waiting', game: null, presence: 1, time: 1010, status: 'idle' },
    ]);
    session.dispose();
  });

  test('does not advance sync revision when full sync fails', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    socket.syncResponder = (acknowledge): void =>
      acknowledge({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, params: {} },
        meta: { requestId: REQUEST_ID, gameProtocolVersion: GAME_PROTOCOL_VERSION },
      });

    expect(await session.synchronize()).toMatchObject({ ok: false });
    expect(session.getSnapshot()).toMatchObject({
      syncStatus: 'idle',
      syncRevision: 1,
      error: { kind: 'server', error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE } },
    });
  });

  test('lets a reentrant subscriber cancel the sync before its late acknowledgement applies', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (nextAcknowledge): void => {
      acknowledge = nextAcknowledge;
    };
    let cancelled = false;
    session.subscribe(() => {
      if (!cancelled && session.getSnapshot().syncStatus === 'synchronizing') {
        cancelled = true;
        session.disconnect();
      }
    });

    const pending = session.synchronize();
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
    });
    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(8), presence: presence(8) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    await Bun.sleep(0);

    expect(socket.syncCount).toBe(2);
    expect(session.getSnapshot()).toMatchObject({
      connection: 'disconnected',
      syncStatus: 'idle',
      syncRevision: 1,
      game: { stateVersion: 1 },
    });
  });

  test('coalesces a synchronize call made reentrantly by a lifecycle subscriber', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (nextAcknowledge): void => {
      acknowledge = nextAcknowledge;
    };
    let reentrant: ReturnType<typeof session.synchronize> | undefined;
    session.subscribe(() => {
      if (reentrant === undefined && session.getSnapshot().syncStatus === 'synchronizing') {
        reentrant = session.synchronize();
      }
    });

    const requested = session.synchronize();
    expect(socket.syncCount).toBe(2);
    expect(reentrant).toBeDefined();
    if (reentrant === undefined) throw new Error('Expected a reentrant synchronization');
    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(5), presence: presence(5) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });

    expect(await Promise.all([requested, reentrant])).toEqual([{ ok: true }, { ok: true }]);
    expect(session.getSnapshot()).toMatchObject({ syncStatus: 'idle', syncRevision: 2 });
  });

  test('rejects a conflicting roll update without applying it and recovers through full sync', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    await session.connect();
    const baseline = session.getSnapshot().game;
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (next) => {
      acknowledge = next;
    };
    try {
      for (const listener of socket.listeners.roomUpdate) {
        listener({
          type: 'roll:committed',
          view: viewFromGame(game(2, true)),
          roll: { ...ROLL, outcome: { authoritativeValuesBySlot: [{ slot: 0, value: 6 }] } },
        });
      }

      expect(session.getSnapshot().game).toBe(baseline);
      expect(session.getSnapshot()).toMatchObject({
        presentation: { kind: 'settled' },
        syncStatus: 'synchronizing',
        error: { kind: 'protocol', code: 'INVALID_RESPONSE' },
      });
      expect(socket.syncCount).toBe(2);
      const recovery = session.synchronize();
      acknowledge?.({
        ok: true,
        data: { room: room(), game: game(2, true), presence: presence(2) },
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
      expect(await recovery).toEqual({ ok: true });
      expect(session.getSnapshot()).toMatchObject({
        game: { stateVersion: 2 },
        presentation: { kind: 'settled' },
        syncStatus: 'idle',
        syncRevision: 2,
        error: null,
      });
      expect(socket.syncCount).toBe(2);
    } finally {
      session.dispose();
    }
  });

  test('does not start malformed-update recovery after an error subscriber disconnects', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    let disconnected = false;
    session.subscribe(() => {
      if (!disconnected && session.getSnapshot().error?.kind === 'protocol') {
        disconnected = true;
        session.disconnect();
      }
    });

    for (const listener of socket.listeners.roomUpdate) listener({ malformed: true });
    await Bun.sleep(0);

    expect(socket.syncCount).toBe(1);
    expect(session.getSnapshot()).toMatchObject({
      connection: 'disconnected',
      syncStatus: 'idle',
      syncRevision: 1,
    });
  });

  test('cancels a full sync on a transport disconnect and ignores its late acknowledgement', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (nextAcknowledge): void => {
      acknowledge = nextAcknowledge;
    };

    const pending = session.synchronize();
    for (const listener of socket.listeners.disconnected) listener();
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
    });
    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(8), presence: presence(8) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    await Bun.sleep(0);

    expect(session.getSnapshot()).toMatchObject({
      connection: 'disconnected',
      syncStatus: 'idle',
      syncRevision: 1,
      game: { stateVersion: 1 },
    });
  });

  test('disposal keeps a late full-sync acknowledgement from changing the final snapshot', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 5_000, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();
    let acknowledge: ((value: unknown) => void) | undefined;
    socket.syncResponder = (nextAcknowledge): void => {
      acknowledge = nextAcknowledge;
    };

    const pending = session.synchronize();
    session.dispose();
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
    });
    acknowledge?.({
      ok: true,
      data: { room: room(), game: game(8), presence: presence(8) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
    await Bun.sleep(0);

    expect(session.getSnapshot()).toMatchObject({
      connection: 'disposed',
      syncStatus: 'idle',
      syncRevision: 1,
      game: { stateVersion: 1 },
    });
  });

  test('uses one execution identity and spends enter intent before any authentication reply', () => {
    let getAuth!: Parameters<GameSocketFactory['create']>[0]['getAuth'];
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: {
        create: (input) => {
          getAuth = input.getAuth;
          return new FakeSocket();
        },
      },
    });
    const first = parseSocketAuth(getAuth());
    const retry = parseSocketAuth(getAuth());
    expect(first.connectionIntent).toBe('enter');
    expect(retry).toEqual({ ...first, connectionIntent: 'reconnect' });
    expect(getAuth()).toEqual(retry);
    session.dispose();
  });

  test.each(['event', 'promise'] as const)(
    'ends a rejected reconnect through its %s without reviving the session',
    async (delivery) => {
      const socket = new FakeSocket();
      const failure = {
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.SESSION_REPLACED, params: {} },
        meta: { requestId: REQUEST_ID, gameProtocolVersion: GAME_PROTOCOL_VERSION },
      };
      socket.connect = async () => {
        if (delivery === 'event')
          for (const listener of socket.listeners.connectionError) listener(failure);
        throw failure;
      };
      const session = createGameSession({
        socketUrl: 'https://game.example.test',
        authority: AUTHORITY,
        contract: createCompatibilityContract('release-1'),
        socketFactory: { create: () => socket },
      });
      const lateConnected = [...socket.listeners.connected];
      const lateDisconnected = [...socket.listeners.disconnected];
      expect((await session.connect()).ok).toBeFalse();
      const terminal = session.getSnapshot();
      expect(terminal.connection).toBe('replaced');
      expect(socket.disposed).toBeTrue();
      for (const callback of [...lateConnected, ...lateDisconnected]) callback();
      await session.connect();
      expect(session.getSnapshot()).toBe(terminal);
      expect(socket.syncCount).toBe(0);
    },
  );

  test('authenticates exactly and syncs on every connection', async () => {
    const socket = new FakeSocket();
    let factoryInput: Parameters<GameSocketFactory['create']>[0] | undefined;
    const factory: GameSocketFactory = {
      create: (input) => {
        factoryInput = input;
        return socket;
      },
    };
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: factory,
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => 'de305d54-75b4-431b-adb2-eb6b9e546010',
    });

    expect(await session.connect()).toMatchObject({ ok: true });
    expect(JSON.parse(JSON.stringify(parseSocketAuth(factoryInput?.getAuth())))).toEqual({
      roomId: ROOM_ID,
      seatToken: SEAT_TOKEN,
      executionId: expect.any(String),
      connectionIntent: 'enter',
      contract: createCompatibilityContract('release-1'),
    });
    expect(factoryInput?.url).toBe('https://game.example.test');
    expect(socket.syncCount).toBe(1);
    expect(session.getSnapshot()).toMatchObject({
      connection: 'connected',
      game: { stateVersion: 1 },
      presence: { presenceVersion: 1 },
    });

    socket.syncVersion = 2;
    for (const listener of socket.listeners.disconnected) listener();
    for (const listener of socket.listeners.connected) listener();
    await Bun.sleep(0);
    expect(socket.syncCount).toBe(2);
    expect(Number(session.getSnapshot().game?.stateVersion)).toBe(2);
  });

  test('applies consecutive and jumped complete views without supplemental sync', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => 'de305d54-75b4-431b-adb2-eb6b9e546010',
    });
    await session.connect();

    for (const listener of socket.listeners.roomUpdate) {
      listener({
        type: 'state:committed',
        view: viewFromGame(game(2)),
      });
    }
    expect(Number(session.getSnapshot().game?.stateVersion)).toBe(2);

    socket.syncVersion = 5;
    for (const listener of socket.listeners.roomUpdate) {
      listener({
        type: 'state:committed',
        view: viewFromGame(game(5)),
      });
    }
    await Bun.sleep(0);
    expect(socket.syncCount).toBe(1);
    expect(Number(session.getSnapshot().game?.stateVersion)).toBe(5);
  });

  test('accepts finished room metadata from the same live view without supplemental sync', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });
    await session.connect();

    for (const listener of socket.listeners.roomUpdate) {
      listener({ type: 'state:committed', view: viewFromGame(finishedGame(2)) });
    }
    await Bun.sleep(0);

    expect(socket.syncCount).toBe(1);
    expect(session.getSnapshot()).toMatchObject({
      room: { status: 'finished' },
      game: { stateVersion: 2, match: { status: 'finished' } },
    });
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

  test.each([
    { gameVersion: 1, presenceVersion: 2, kind: 'roll' },
    { gameVersion: 2, presenceVersion: 2, kind: 'settled' },
    { gameVersion: 2, presenceVersion: 1, kind: 'settled' },
    { gameVersion: 3, presenceVersion: 2, kind: 'settled' },
  ] as const)(
    'full sync $gameVersion/$presenceVersion confirms authority with $kind presentation',
    async ({ gameVersion, presenceVersion, kind }) => {
      const socket = new FakeSocket();
      const clock = createServerClock(() => 0);
      const session = createGameSession({
        socketUrl: 'https://game.example.test',
        authority: AUTHORITY,
        contract: createCompatibilityContract('release-1'),
        socketFactory: { create: () => socket },
        clock,
      });
      try {
        await session.connect();
        for (const listener of socket.listeners.roomUpdate)
          listener({ type: 'roll:committed', view: viewFromGame(game(2, true), 2), roll: ROLL });
        const fresh = session.getSnapshot();
        socket.syncResponder = (acknowledge) =>
          acknowledge({
            ok: true,
            data: viewFromGame(game(gameVersion, gameVersion >= 2), presenceVersion),
            meta: {
              requestId: REQUEST_ID,
              serverTime: 2000,
              gameProtocolVersion: GAME_PROTOCOL_VERSION,
            },
          });
        expect(await session.synchronize()).toEqual({ ok: true });
        const restored = session.getSnapshot();
        expect(restored.presentation?.kind).toBe(kind);
        expect(restored.syncRevision).toBe(2);
        expect(Number(restored.game?.stateVersion)).toBe(Math.max(2, gameVersion));
        expect(Number(restored.presence?.presenceVersion)).toBe(2);
        expect(clock.now()).toBe(2000);
        if (kind === 'roll') expect(restored.presentation).toBe(fresh.presentation);
      } finally {
        session.dispose();
      }
    },
  );

  test('rejects crossed full-sync counters before confirming recovery or accepting its clock', async () => {
    const socket = new FakeSocket();
    const clock = createServerClock(() => 0);
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      clock,
    });
    try {
      await session.connect();
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'roll:committed', view: viewFromGame(game(2, true), 2), roll: ROLL });
      const fresh = session.getSnapshot();
      socket.syncResponder = (acknowledge) =>
        acknowledge({
          ok: true,
          data: viewFromGame(game(1), 3),
          meta: {
            requestId: REQUEST_ID,
            serverTime: 9000,
            gameProtocolVersion: GAME_PROTOCOL_VERSION,
          },
        });
      expect(await session.synchronize()).toMatchObject({
        ok: false,
        error: { code: 'INVALID_RESPONSE' },
      });
      expect(session.getSnapshot()).toMatchObject({
        syncRevision: 1,
        game: { stateVersion: 2 },
        presence: { presenceVersion: 2 },
      });
      expect(session.getSnapshot().presentation).toBe(fresh.presentation);
      expect(session.getSnapshot().game).toBe(fresh.game);
      expect(clock.now()).toBe(1000);
    } finally {
      session.dispose();
    }
  });

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

  test('a start view received during initial waiting sync needs no metadata sync afterward', async () => {
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
        listener({ type: 'state:committed', view: viewFromGame(game(1), 2) });
      acknowledge({
        ok: true,
        data: {
          room: {
            status: 'waiting',
            roomId: ROOM_ID,
            roomCode: '123456',
            createdAt: 1,
            expiresAt: 301000,
            seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
          },
          game: null,
          presence: { roomId: ROOM_ID, presenceVersion: 1, seats: [{ status: 'connected' }] },
        },
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
      expect(await connected).toEqual({ ok: true });
      expect(session.getSnapshot()).toMatchObject({
        room: {
          status: 'playing',
          seats: [
            { profile: { characterId: 'navy-bob' } },
            { profile: { characterId: 'blonde-buns' } },
          ],
        },
        game: { stateVersion: 1 },
        presence: { presenceVersion: 2 },
        syncRevision: 1,
      });
      expect(socket.syncCount).toBe(1);
    } finally {
      session.dispose();
    }
  });

  test('a finish view survives an older in-flight playing sync without a successor request', async () => {
    const socket = new FakeSocket();
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
      const pending = session.synchronize();
      for (const listener of socket.listeners.roomUpdate)
        listener({ type: 'state:committed', view: viewFromGame(finishedGame(2), 2) });
      const finished = session.getSnapshot();
      acknowledge({
        ok: true,
        data: viewFromGame(game(1)),
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
      expect(await pending).toEqual({ ok: true });
      expect(session.getSnapshot()).toMatchObject({
        room: { status: 'finished' },
        game: { stateVersion: 2, match: { status: 'finished' } },
        presence: { presenceVersion: 2 },
        syncRevision: 2,
      });
      expect(session.getSnapshot().game).toBe(finished.game);
      expect(session.getSnapshot().room).toBe(finished.room);
      expect(socket.syncCount).toBe(2);
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

  test('removes every listener and remains silent after dispose', async () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => 'de305d54-75b4-431b-adb2-eb6b9e546010',
    });
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });
    await session.connect();
    expect(notifications).toBeGreaterThan(0);
    const notificationsBeforeDispose = notifications;
    session.dispose();

    expect(notifications).toBe(notificationsBeforeDispose);
    expect(socket.disposed).toBeTrue();
    expect(Object.values(socket.listeners).every((listeners) => listeners.size === 0)).toBeTrue();
    expect(await session.connect()).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
    });
    expect(notifications).toBe(notificationsBeforeDispose);
  });

  test('settles a pending connect when explicitly disconnected', async () => {
    const socket = new FakeSocket();
    socket.connect = () => new Promise<void>(() => {});
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
    });

    const pending = session.connect();
    session.disconnect();

    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: 'transport', code: 'SOCKET_DISCONNECTED' },
    });
    expect(session.getSnapshot().connection).toBe('disconnected');
    session.dispose();
  });

  test('preserves the disposed snapshot when a pending connection settles', async () => {
    const socket = new FakeSocket();
    socket.connect = () => new Promise<void>(() => {});
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
    });
    const connectedCallbacks = [...socket.listeners.connected];
    const pending = session.connect();
    session.dispose();
    const disposedSnapshot = session.getSnapshot();

    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
    });
    expect(session.getSnapshot()).toBe(disposedSnapshot);
    for (const callback of connectedCallbacks) callback();
    expect(session.getSnapshot()).toBe(disposedSnapshot);
    expect(session.getSnapshot().connection).toBe('disposed');
    expect(socket.syncCount).toBe(0);
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

  test('maps a handshake version rejection to one protocol compatibility error', () => {
    const socket = new FakeSocket();
    const session = createGameSession({
      socketUrl: 'https://game.example.test',
      authority: AUTHORITY,
      contract: createCompatibilityContract('release-1'),
      socketFactory: { create: () => socket },
      retryPolicy: { acknowledgementTimeoutMs: 20, maximumAttempts: 1, retryDelayMs: 0 },
      createActionId: () => 'de305d54-75b4-431b-adb2-eb6b9e546010',
    });

    for (const listener of socket.listeners.connectionError) {
      listener({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH, params: {} },
        meta: {
          requestId: REQUEST_ID,
          serverTime: 1000,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      });
    }

    expect(session.getSnapshot()).toMatchObject({
      connection: 'disconnected',
      error: {
        kind: 'protocol',
        code: 'PROTOCOL_MISMATCH',
        requestId: REQUEST_ID,
      },
    });
    session.dispose();
  });
});
