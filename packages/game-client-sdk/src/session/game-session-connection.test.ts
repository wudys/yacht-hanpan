import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { GAME_SOCKET_PATH, parseSocketAuth, SOCKET_EVENT } from '@repo/game-protocol/socket';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import type { GameSocketFactory } from '../socket/game-socket';
import { createGameSession } from './game-session';
import {
  AUTHORITY,
  authority,
  ConnectionSocket,
  FakeSocket,
  game,
  presence,
  REQUEST_ID,
  RESPONSE,
  room,
  ROOM_ID,
  SEAT_TOKEN,
  view,
} from './game-session.test-fixtures';

function sessionFor(socket: ConnectionSocket) {
  return createGameSession({
    socketUrl: 'https://game.example.test',
    authority,
    contract: createCompatibilityContract('release-1'),
    socketFactory: { create: () => socket },
  });
}

function pendingConnection() {
  const socket = new ConnectionSocket();
  const transport = Promise.withResolvers<void>();
  const acknowledgements: ((value: unknown) => void)[] = [];
  socket.connect = () => {
    socket.connectCount += 1;
    socket.connected = true;
    for (const listener of socket.listeners.connected) listener();
    return transport.promise;
  };
  socket.emitSync = (acknowledge) => {
    socket.syncCount += 1;
    acknowledgements.push(acknowledge);
  };
  return { socket, transport, acknowledgements, session: sessionFor(socket) };
}

function replace(socket: ConnectionSocket): void {
  for (const listener of socket.listeners.replaced) listener();
}

describe('game session connection', () => {
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

  test('fulfills connect without an event and ignores a later duplicate connected event', async () => {
    const socket = new ConnectionSocket();
    socket.connect = async () => {
      socket.connectCount += 1;
      socket.connected = true;
    };
    const session = sessionFor(socket);
    try {
      expect(await session.connect()).toEqual({ ok: true });
      expect(session.getSnapshot()).toMatchObject({
        connection: 'connected',
        syncStatus: 'idle',
        syncRevision: 1,
        room: view.room,
      });
      const confirmed = session.getSnapshot();
      for (const listener of socket.listeners.connected) listener();
      expect(session.getSnapshot()).toBe(confirmed);
      expect(socket.syncCount).toBe(1);
      expect(await session.connect()).toEqual({ ok: true });
      expect(socket.syncCount).toBe(2);
    } finally {
      session.dispose();
    }
  });

  test.each([false, true])(
    'disconnect closes local state with adapter callback %s',
    async (callback) => {
      const socket = new ConnectionSocket();
      if (!callback)
        socket.disconnect = () => {
          socket.connected = false;
        };
      const session = sessionFor(socket);
      try {
        expect(await session.connect()).toEqual({ ok: true });
        let publications = 0;
        session.subscribe(() => {
          publications += 1;
        });
        session.disconnect();
        expect(session.getSnapshot()).toMatchObject({
          connection: 'disconnected',
          syncStatus: 'idle',
        });
        expect(await session.setDieHeld(0, true)).toMatchObject({
          ok: false,
          error: { code: 'SOCKET_DISCONNECTED' },
        });
        session.disconnect();
        expect(publications).toBe(1);
      } finally {
        session.dispose();
      }
    },
  );

  test('disconnect publication can reconnect before the old transport continuation finishes', async () => {
    const { socket, transport, acknowledgements, session } = pendingConnection();
    const reconnects: ReturnType<typeof session.connect>[] = [];
    session.subscribe(() => {
      if (session.getSnapshot().connection === 'disconnected' && reconnects.length === 0) {
        reconnects.push(session.connect());
      }
    });
    try {
      const first = session.connect();
      session.disconnect();
      expect(socket.connectCount).toBe(2);
      transport.resolve();
      acknowledgements[1]!({ ok: true, data: view, meta: RESPONSE.meta });
      expect(await first).toMatchObject({ ok: false, error: { code: 'SOCKET_DISCONNECTED' } });
      expect(await Promise.all(reconnects)).toEqual([{ ok: true }]);
      expect(session.getSnapshot()).toMatchObject({ connection: 'connected', syncRevision: 1 });
    } finally {
      session.dispose();
    }
  });

  test('a raw transport disconnect followed by automatic reconnect confirms a new full sync', async () => {
    const socket = new ConnectionSocket();
    const session = sessionFor(socket);
    try {
      expect(await session.connect()).toEqual({ ok: true });
      socket.disconnect();
      socket.connected = true;
      for (const listener of socket.listeners.connected) listener();
      await Bun.sleep(0);
      expect(socket.connectCount).toBe(1);
      expect(socket.syncCount).toBe(2);
      expect(session.getSnapshot()).toMatchObject({
        connection: 'connected',
        syncStatus: 'idle',
        syncRevision: 2,
      });
    } finally {
      session.dispose();
    }
  });

  test('explicit disconnect ignores a late connected event from the completed transport', async () => {
    const socket = new ConnectionSocket();
    const session = sessionFor(socket);
    try {
      expect(await session.connect()).toEqual({ ok: true });
      session.disconnect();
      const disconnected = session.getSnapshot();
      for (const listener of socket.listeners.connected) listener();
      await Bun.sleep(0);
      expect(session.getSnapshot()).toBe(disconnected);
      expect(socket.syncCount).toBe(1);
    } finally {
      session.dispose();
    }
  });

  test('coalesces a connect made reentrantly by a connecting subscriber', async () => {
    const socket = new ConnectionSocket();
    const session = sessionFor(socket);
    const joined: ReturnType<typeof session.connect>[] = [];
    let requested = false;
    session.subscribe(() => {
      if (session.getSnapshot().connection !== 'connecting' || requested) return;
      requested = true;
      joined.push(session.connect());
    });

    expect(await session.connect()).toEqual({ ok: true });
    expect(joined).toHaveLength(1);
    expect(await Promise.all(joined)).toEqual([{ ok: true }]);
    expect(socket.connectCount).toBe(1);
    expect(socket.syncCount).toBe(1);
    session.dispose();
  });

  test('disconnect during connecting publication cancels transport start and permits a later connect', async () => {
    const socket = new ConnectionSocket();
    const session = sessionFor(socket);
    const unsubscribe = session.subscribe(() => {
      if (session.getSnapshot().connection === 'connecting') session.disconnect();
    });

    expect(await session.connect()).toMatchObject({
      ok: false,
      error: { kind: 'transport', code: 'SOCKET_DISCONNECTED' },
    });
    expect(socket.connectCount).toBe(0);
    expect(socket.syncCount).toBe(0);
    expect(session.getSnapshot().connection).toBe('disconnected');

    unsubscribe();
    expect(await session.connect()).toEqual({ ok: true });
    expect(socket.connectCount).toBe(1);
    expect(socket.syncCount).toBe(1);
    session.dispose();
  });

  test('connect failure keeps its error when a subscriber replaces the session', async () => {
    const socket = new ConnectionSocket();
    socket.connect = async () => {
      throw new Error('offline');
    };
    const session = sessionFor(socket);
    session.subscribe(() => {
      if (session.getSnapshot().connection !== 'disconnected') return;
      for (const callback of socket.listeners.replaced) callback();
    });

    expect(await session.connect()).toMatchObject({
      ok: false,
      error: { kind: 'transport', code: 'SOCKET_DISCONNECTED' },
    });
    expect(session.getSnapshot()).toMatchObject({ connection: 'replaced', error: null });
    expect(socket.disposed).toBe(true);
    expect(socket.syncCount).toBe(0);
    session.dispose();
  });

  test.each([PUBLIC_ERROR_CODE.INVALID_AUTHORITY, PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH])(
    'preserves the original %s authentication error through replacement publication',
    async (code) => {
      const socket = new ConnectionSocket();
      socket.connect = () =>
        Promise.reject({ ok: false, error: { code, params: {} }, meta: RESPONSE.meta });
      const session = sessionFor(socket);
      session.subscribe(() => {
        if (session.getSnapshot().connection === 'disconnected') replace(socket);
      });
      try {
        expect(await session.connect()).toEqual({
          ok: false,
          error:
            code === PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH
              ? { kind: 'protocol', code, requestId: RESPONSE.meta.requestId }
              : {
                  kind: 'server',
                  error: { code, params: {} },
                  requestId: RESPONSE.meta.requestId,
                },
        });
        expect(session.getSnapshot()).toMatchObject({ connection: 'replaced', error: null });
        expect(socket.syncCount).toBe(0);
      } finally {
        session.dispose();
      }
    },
  );

  test.each([PUBLIC_ERROR_CODE.INVALID_AUTHORITY, PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH])(
    'preserves %s when the adapter error event precedes transport rejection',
    async (code) => {
      const socket = new ConnectionSocket();
      const transport = Promise.withResolvers<void>();
      socket.connect = () => transport.promise;
      const session = sessionFor(socket);
      const expectedError =
        code === PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH
          ? { kind: 'protocol' as const, code, requestId: RESPONSE.meta.requestId }
          : {
              kind: 'server' as const,
              error: { code, params: {} },
              requestId: RESPONSE.meta.requestId,
            };
      try {
        const connection = session.connect();
        const failure = { ok: false, error: { code, params: {} }, meta: RESPONSE.meta };
        // The adapter publishes connect_error before its connect Promise rejects.
        for (const listener of socket.listeners.connectionError) listener(failure);
        expect(session.getSnapshot()).toMatchObject({
          connection: 'disconnected',
          error: expectedError,
        });
        transport.reject(failure);

        expect(await connection).toEqual({ ok: false, error: expectedError });
        expect(session.getSnapshot()).toMatchObject({
          connection: 'disconnected',
          error: expectedError,
          syncStatus: 'idle',
          syncRevision: 0,
          room: null,
        });
        expect(socket.syncCount).toBe(0);
      } finally {
        session.dispose();
      }
    },
  );

  test('a late authentication error event and rejection cannot revive a disposed session', async () => {
    const socket = new ConnectionSocket();
    const transport = Promise.withResolvers<void>();
    socket.connect = () => transport.promise;
    const session = sessionFor(socket);
    const lateErrors = [...socket.listeners.connectionError];
    const connection = session.connect();
    session.dispose();
    const finalSnapshot = session.getSnapshot();
    const failure = {
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} },
      meta: RESPONSE.meta,
    };
    for (const listener of lateErrors) listener(failure);
    transport.reject(failure);

    expect(await connection).toMatchObject({
      ok: false,
      error: { kind: 'protocol', code: 'SESSION_DISPOSED' },
    });
    expect(session.getSnapshot()).toBe(finalSnapshot);
    expect(finalSnapshot).toMatchObject({ connection: 'disposed', error: null });
    expect(socket.syncCount).toBe(0);
  });

  test.each(['explicit', 'raw transport'] as const)(
    '%s disconnect in the fulfilled transport continuation gap cannot restart sync',
    async (source) => {
      const { socket, transport, acknowledgements, session } = pendingConnection();
      const publications: { connection: string; syncStatus: string }[] = [];
      session.subscribe(() => {
        const { connection, syncStatus } = session.getSnapshot();
        publications.push({ connection, syncStatus });
      });
      try {
        const connection = session.connect();
        transport.resolve();
        // Resolve the wrapped transport Promise, then cancel before its await resumes.
        queueMicrotask(() => {
          if (source === 'explicit') session.disconnect();
          else {
            socket.connected = false;
            for (const listener of socket.listeners.disconnected) listener();
          }
        });
        await Bun.sleep(0);

        expect(socket.syncCount).toBe(1);
        expect(publications).not.toContainEqual({
          connection: 'disconnected',
          syncStatus: 'synchronizing',
        });
        expect(await connection).toMatchObject({
          ok: false,
          error: { kind: 'transport', code: 'SOCKET_DISCONNECTED' },
        });
        acknowledgements[0]!({ ok: true, data: view, meta: RESPONSE.meta });
        await Promise.resolve();
        expect(session.getSnapshot()).toMatchObject({
          connection: 'disconnected',
          syncStatus: 'idle',
          syncRevision: 0,
          room: null,
          game: null,
          presentation: null,
        });

        const reconnect = session.connect();
        expect(socket.syncCount).toBe(2);
        acknowledgements[1]!({ ok: true, data: view, meta: RESPONSE.meta });
        expect(await reconnect).toEqual({ ok: true });
        expect(socket.connectCount).toBe(2);
        expect(session.getSnapshot()).toMatchObject({
          connection: 'connected',
          syncRevision: 1,
          room: view.room,
        });
      } finally {
        session.dispose();
      }
    },
  );

  test.each(['dispose', 'replace'] as const)(
    '%s in the fulfilled transport continuation gap ends connect permanently',
    async (end) => {
      const { socket, transport, acknowledgements, session } = pendingConnection();
      try {
        const connection = session.connect();
        transport.resolve();
        queueMicrotask(() => (end === 'dispose' ? session.dispose() : replace(socket)));
        expect(await connection).toMatchObject({
          ok: false,
          error: { code: 'SESSION_DISPOSED' },
        });
        expect(socket.syncCount).toBe(1);
        acknowledgements[0]!({ ok: true, data: view, meta: RESPONSE.meta });
        await Promise.resolve();
        expect(session.getSnapshot()).toMatchObject({
          connection: end === 'dispose' ? 'disposed' : 'replaced',
          syncRevision: 0,
          room: null,
        });
        expect(await session.connect()).toMatchObject({
          ok: false,
          error: { code: 'SESSION_DISPOSED' },
        });
        expect(socket.connectCount).toBe(1);
      } finally {
        session.dispose();
      }
    },
  );

  test.each(['disconnect', 'dispose', 'replace'] as const)(
    '%s during confirmed sync publication preserves the completed connect result',
    async (end) => {
      const { socket, transport, acknowledgements, session } = pendingConnection();
      try {
        const connection = session.connect();
        transport.resolve();
        await Bun.sleep(0);
        session.subscribe(() => {
          if (session.getSnapshot().connection !== 'connected') return;
          if (session.getSnapshot().syncRevision !== 1) return;
          if (end === 'replace') replace(socket);
          else session[end]();
        });
        acknowledgements[0]!({ ok: true, data: view, meta: RESPONSE.meta });

        expect(await connection).toEqual({ ok: true });
        expect(socket.syncCount).toBe(1);
        expect(session.getSnapshot()).toMatchObject({
          connection:
            end === 'replace' ? 'replaced' : end === 'dispose' ? 'disposed' : 'disconnected',
          syncRevision: 1,
          room: view.room,
        });
      } finally {
        session.dispose();
      }
    },
  );

  test.each(['explicit disconnect', 'server close before sync ACK'] as const)(
    'the default adapter sends no cancelled sync on the next connection after %s',
    async (cancellation) => {
      const syncCounts: number[] = [];
      const server = Bun.serve<{ connectionIndex: number }>({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request, server) {
          if (new URL(request.url).pathname !== `${GAME_SOCKET_PATH}/`)
            return new Response(null, { status: 404 });
          if (server.upgrade(request, { data: { connectionIndex: 0 } })) return;
          return new Response(null, { status: 400 });
        },
        websocket: {
          open(socket) {
            socket.data.connectionIndex = syncCounts.length;
            syncCounts.push(0);
            socket.send(
              `0${JSON.stringify({ sid: 'cancel-engine', upgrades: [], pingInterval: 60_000, pingTimeout: 60_000, maxPayload: 1024 })}`,
            );
          },
          message(socket, message) {
            const packet = String(message);
            if (packet.startsWith('40')) {
              socket.send(`40${JSON.stringify({ sid: 'cancel-socket' })}`);
              return;
            }
            const event = /^42(\d+)(\[.*\])$/u.exec(packet);
            if (!event || JSON.parse(event[2]!)[0] !== SOCKET_EVENT.GAME_SYNC) return;
            syncCounts[socket.data.connectionIndex]! += 1;
            if (
              cancellation === 'server close before sync ACK' &&
              socket.data.connectionIndex === 0
            ) {
              socket.close();
              return;
            }
            socket.send(
              `43${event[1]}${JSON.stringify([{ ok: true, data: view, meta: RESPONSE.meta }])}`,
            );
          },
        },
      });
      const session = createGameSession({
        socketUrl: `http://127.0.0.1:${server.port}`,
        authority,
        contract: createCompatibilityContract('release-1'),
        retryPolicy: { acknowledgementTimeoutMs: 1000, maximumAttempts: 1, retryDelayMs: 0 },
      });
      let cancelled = false;
      const publications: { connection: string; syncStatus: string }[] = [];
      session.subscribe(() => {
        const { connection, syncStatus } = session.getSnapshot();
        publications.push({ connection, syncStatus });
        if (
          cancellation !== 'explicit disconnect' ||
          cancelled ||
          connection !== 'connected' ||
          syncStatus !== 'synchronizing'
        )
          return;
        cancelled = true;
        // The SDK connected listener precedes the adapter's transport resolver.
        void Promise.resolve().then(() => queueMicrotask(() => session.disconnect()));
      });
      try {
        const result = await session.connect();
        expect(result).toMatchObject({
          ok: false,
          error: {
            code:
              cancellation === 'explicit disconnect' ? 'SOCKET_DISCONNECTED' : 'SESSION_DISPOSED',
          },
        });
        expect(publications).not.toContainEqual({
          connection: 'disconnected',
          syncStatus: 'synchronizing',
        });
        expect(session.getSnapshot()).toMatchObject({
          connection: 'disconnected',
          syncRevision: 0,
        });
        if (cancellation === 'server close before sync ACK') expect(syncCounts[0]).toBe(1);

        expect(await session.connect()).toEqual({ ok: true });
        expect(syncCounts).toHaveLength(2);
        expect(syncCounts[1]).toBe(1);
        expect(session.getSnapshot().syncRevision).toBe(1);
      } finally {
        session.dispose();
        await server.stop(true);
      }
    },
  );
});
