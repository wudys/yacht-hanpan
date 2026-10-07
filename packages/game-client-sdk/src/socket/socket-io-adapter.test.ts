import {
  parseCommittedRoomUpdate,
  parseSocketAuth,
  SOCKET_EVENT,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { describe, expect, jest, test } from 'bun:test';

import { createSocketIoGameSocket } from './socket-io-adapter';

const authentication = parseSocketAuth({
  roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
  seatToken: '550e8400-e29b-41d4-a716-446655440000',
  contract: createCompatibilityContract('test'),
  executionId: '550e8400-e29b-41d4-a716-446655440001',
  connectionIntent: 'enter',
});

function unresponsiveAuthenticationServer() {
  const closed = Promise.withResolvers<void>();
  let opened!: () => void;
  const authenticating = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.send(
          `0${JSON.stringify({
            sid: 'test-engine-only',
            upgrades: [],
            pingInterval: 60_000,
            pingTimeout: 60_000,
            maxPayload: 1_024,
          })}`,
        );
      },
      message(_socket, message) {
        if (String(message).startsWith('40')) opened();
      },
      close() {
        closed.resolve();
      },
    },
  });
  return { server, authenticating, closed: closed.promise };
}

describe('Socket.IO authentication boundary', () => {
  test('an error subscriber reconnect keeps its cancellation and cannot time out a later connection', async () => {
    // Module substitution stays in a separate process so other adapter tests use real Socket.IO.
    const subprocess = Bun.spawn(
      [process.execPath, new URL('./socket-io-reentry.test-fixtures.ts', import.meta.url).pathname],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  });

  test('delivers one complete room-state event and removes its listener on unsubscribe', async () => {
    const update = parseCommittedRoomUpdate({
      type: 'state:committed',
      view: {
        room: {
          status: 'waiting',
          roomId: authentication.roomId,
          roomCode: '123456',
          createdAt: 1,
          expiresAt: 301000,
          seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
        },
        game: null,
        presence: {
          roomId: authentication.roomId,
          presenceVersion: 1,
          seats: [{ status: 'connected' }],
        },
      },
    });
    const secondUpdate = parseCommittedRoomUpdate({
      ...update,
      view: {
        ...update.view,
        presence: { ...update.view.presence, presenceVersion: 2 },
      },
    });
    let sendUpdate!: (value: ReturnType<typeof parseCommittedRoomUpdate>) => void;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          socket.send(
            `0${JSON.stringify({ sid: 'view-engine', upgrades: [], pingInterval: 60000, pingTimeout: 60000, maxPayload: 1024 })}`,
          );
        },
        message(socket, message) {
          if (!String(message).startsWith('40')) return;
          sendUpdate = (value) => {
            socket.send(`42${JSON.stringify([SOCKET_EVENT.ROOM_STATE, value])}`);
          };
          socket.send(`40${JSON.stringify({ sid: 'view-socket' })}`);
        },
      },
    });
    const socket = createSocketIoGameSocket(
      `http://127.0.0.1:${server.port}`,
      () => authentication,
    );
    const received: unknown[] = [];
    const first = Promise.withResolvers<void>();
    const unsubscribe = socket.onRoomUpdate((value) => {
      received.push(value);
      first.resolve();
    });
    const observed: unknown[] = [];
    const second = Promise.withResolvers<void>();
    const stopObserving = socket.onRoomUpdate((value) => {
      observed.push(value);
      if (
        parseCommittedRoomUpdate(value).view.presence.presenceVersion ===
        secondUpdate.view.presence.presenceVersion
      ) {
        second.resolve();
      }
    });
    try {
      await socket.connect();
      sendUpdate(update);
      await first.promise;
      expect(received).toEqual([update]);
      unsubscribe();
      sendUpdate(secondUpdate);
      await second.promise;
      expect(observed).toEqual([update, secondUpdate]);
      expect(received).toEqual([update]);
    } finally {
      unsubscribe();
      stopObserving();
      socket.dispose();
      await server.stop(true);
    }
  });

  test('requests fresh authentication after losing the first namespace response', async () => {
    const received: unknown[] = [];
    let requests = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          socket.send(
            `0${JSON.stringify({ sid: 'retry-engine', upgrades: [], pingInterval: 60_000, pingTimeout: 60_000, maxPayload: 1024 })}`,
          );
        },
        message(socket, message) {
          const packet = String(message);
          if (!packet.startsWith('40')) return;
          received.push(JSON.parse(packet.slice(2)));
          if (received.length === 1) socket.close();
          else socket.send(`40${JSON.stringify({ sid: 'retry-socket' })}`);
        },
      },
    });
    const socket = createSocketIoGameSocket(`http://127.0.0.1:${server.port}`, () => {
      requests += 1;
      return requests === 1 ? authentication : { ...authentication, connectionIntent: 'reconnect' };
    });
    try {
      await socket.connect();
      expect(received).toEqual([
        authentication,
        { ...authentication, connectionIntent: 'reconnect' },
      ]);
      expect(requests).toBe(2);
    } finally {
      socket.dispose();
      await server.stop(true);
    }
  });

  test('delivers the explicit replacement event before the transport closes', async () => {
    let replace!: () => void;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        open(socket) {
          socket.send(
            `0${JSON.stringify({ sid: 'replacement-engine', upgrades: [], pingInterval: 60_000, pingTimeout: 60_000, maxPayload: 1024 })}`,
          );
        },
        message(socket, message) {
          if (!String(message).startsWith('40')) return;
          replace = () => {
            socket.send(`42${JSON.stringify([SOCKET_EVENT.SESSION_REPLACED])}`);
            socket.send('41');
          };
          socket.send(`40${JSON.stringify({ sid: 'replacement-socket' })}`);
        },
      },
    });
    const socket = createSocketIoGameSocket(
      `http://127.0.0.1:${server.port}`,
      () => authentication,
    );
    const replaced = Promise.withResolvers<void>();
    let replacementCount = 0;
    socket.onReplaced(() => {
      replacementCount += 1;
      socket.dispose();
      replaced.resolve();
    });
    try {
      await socket.connect();
      replace();
      await replaced.promise;
      expect(replacementCount).toBe(1);
    } finally {
      socket.dispose();
      await server.stop(true);
    }
  });

  test('ends an unacknowledged namespace authentication within 20 seconds', async () => {
    const { server, authenticating, closed } = unresponsiveAuthenticationServer();
    const socket = createSocketIoGameSocket(
      `http://127.0.0.1:${server.port}`,
      () => authentication,
    );
    try {
      jest.useFakeTimers();
      let settled = false;
      const outcome = socket.connect().then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await authenticating;
      jest.advanceTimersByTime(19_999);
      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(1);
      expect(await outcome).toMatchObject({ message: 'Socket authentication timed out' });
      await closed;
    } finally {
      socket.dispose();
      jest.useRealTimers();
      await server.stop(true);
    }
  });

  test.each(['disconnect', 'dispose'] as const)(
    '%s settles a pending authentication',
    async (end) => {
      const { server, authenticating, closed } = unresponsiveAuthenticationServer();
      const socket = createSocketIoGameSocket(
        `http://127.0.0.1:${server.port}`,
        () => authentication,
      );
      try {
        const outcome = socket.connect().then(
          () => 'connected',
          () => 'failed',
        );
        await authenticating;
        socket[end]();
        expect(await outcome).toBe('failed');
        await closed;
      } finally {
        socket.dispose();
        await server.stop(true);
      }
    },
  );
});
