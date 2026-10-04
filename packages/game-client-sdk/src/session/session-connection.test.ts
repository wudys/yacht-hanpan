import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomResponse } from '@repo/game-protocol/http';
import { GAME_SOCKET_PATH, SOCKET_EVENT } from '@repo/game-protocol/socket';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import type { RawGameSocket } from '../ports';
import { createGameSession } from './session';

const RESPONSE = parseCreateRoomResponse({
  ok: true,
  data: {
    authority: {
      roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
      seatIndex: 0,
      seatToken: '550e8400-e29b-41d4-a716-446655440000',
    },
    view: {
      room: {
        status: 'waiting',
        roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
        roomCode: '123456',
        createdAt: 1,
        expiresAt: 301_000,
        seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
      },
      game: null,
      presence: {
        roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
        presenceVersion: 0,
        seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
      },
    },
  },
  meta: {
    requestId: '9d6ffbb8-10a4-4d43-8c46-cd035b9e87f0',
    serverTime: 1000,
    gameProtocolVersion: GAME_PROTOCOL_VERSION,
  },
});
if (!RESPONSE.ok) throw new Error('Expected waiting room fixture');
const { authority, view } = RESPONSE.data;

class ConnectionSocket implements RawGameSocket {
  readonly listeners = {
    connected: new Set<() => void>(),
    disconnected: new Set<() => void>(),
    replaced: new Set<() => void>(),
    connectionError: new Set<(value: unknown) => void>(),
  };
  connectCount = 0;
  syncCount = 0;
  disposed = false;
  connected = false;

  connect = async (): Promise<void> => {
    this.connectCount += 1;
    this.connected = true;
    for (const listener of this.listeners.connected) listener();
  };
  disconnect = (): void => {
    if (!this.connected) return;
    this.connected = false;
    for (const listener of this.listeners.disconnected) listener();
  };
  dispose = (): void => {
    this.disposed = true;
    this.connected = false;
    Object.values(this.listeners).forEach((listeners) => listeners.clear());
  };
  emitSync: RawGameSocket['emitSync'] = (acknowledge) => {
    this.syncCount += 1;
    acknowledge({ ok: true, data: view, meta: RESPONSE.meta });
  };
  emitCommand: RawGameSocket['emitCommand'] = () => {};
  onConnectionError: RawGameSocket['onConnectionError'] = (listener) => {
    this.listeners.connectionError.add(listener);
    return () => this.listeners.connectionError.delete(listener);
  };
  onRoomUpdate: RawGameSocket['onRoomUpdate'] = () => () => {};
  onConnected: RawGameSocket['onConnected'] = (listener) => this.add('connected', listener);
  onDisconnected: RawGameSocket['onDisconnected'] = (listener) =>
    this.add('disconnected', listener);
  onReplaced: RawGameSocket['onReplaced'] = (listener) => this.add('replaced', listener);

  private add(key: 'connected' | 'disconnected' | 'replaced', listener: () => void): () => void {
    this.listeners[key].add(listener);
    return () => this.listeners[key].delete(listener);
  }
}

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

describe('connection publication', () => {
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
});

describe('connection cancellation', () => {
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
