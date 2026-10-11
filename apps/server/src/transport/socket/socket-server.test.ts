import { GAME_SOCKET_PATH } from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { io as createClient } from 'socket.io-client';

import {
  createSocketServerTestFixture,
  createTestRoom,
  RELEASE_ID,
  startAdmissionServer,
  within,
} from '@/app/socket-server.test-fixture';
import { startGameServer } from '@/app/start-game-server';
import { SocketConnectionLimit } from '@/transport/socket/socket-connection-limit';

const { servers, clients, connect, close } = createSocketServerTestFixture();

afterEach(close);

describe('Socket server admission', () => {
  test('reserves a bounded number of unauthenticated transports across concurrent upgrades', async () => {
    const { socketServer, url } = await startAdmissionServer({ maxTransports: 2 });
    const raw = Array.from(
      { length: 3 },
      () => new WebSocket(`${url}${GAME_SOCKET_PATH}/?EIO=4&transport=websocket`),
    );
    try {
      const opened = await Promise.all(
        raw.map((client) =>
          receiveWebSocketMessage(client).then(
            () => true,
            () => false,
          ),
        ),
      );
      expect(opened.filter(Boolean)).toHaveLength(2);
      expect(socketServer.counts().transports).toBe(2);
      const first = raw[opened.findIndex(Boolean)]!;
      const closed = new Promise<void>((resolve) =>
        first.addEventListener('close', () => resolve(), { once: true }),
      );
      first.close();
      await within(closed, 'raw transport closed');
      const replacement = new WebSocket(`${url}${GAME_SOCKET_PATH}/?EIO=4&transport=websocket`);
      raw.push(replacement);
      expect((await receiveWebSocketMessage(replacement)).startsWith('0')).toBeTrue();
    } finally {
      raw.forEach((client) => client.close());
      await socketServer.close();
    }
    expect(socketServer.counts()).toEqual({ transports: 0, authenticating: 0 });
  });

  test('closes transports that never authenticate within the connection budget', async () => {
    const { socketServer, url } = await startAdmissionServer({ authenticationTimeoutMs: 20 });
    const client = new WebSocket(`${url}${GAME_SOCKET_PATH}/?EIO=4&transport=websocket`);
    const closed = new Promise<void>((resolve) =>
      client.addEventListener('close', () => resolve(), { once: true }),
    );
    try {
      await receiveWebSocketMessage(client);
      await within(closed, 'authentication deadline');
      expect(socketServer.counts().transports).toBe(0);
    } finally {
      client.close();
      await socketServer.close();
    }
  });

  test('charges Socket admission to the same trusted edge IP as HTTP', async () => {
    const server = await startGameServer({
      config: {
        allowedOrigins: [],
        trustRenderProxy: true,
        host: '127.0.0.1',
        port: 0,
        releaseId: RELEASE_ID,
      },
    });
    servers.push(server);
    const authority = await createTestRoom(server.url, crypto.randomUUID());
    const acquire = spyOn(SocketConnectionLimit.prototype, 'acquire');
    try {
      const client = await connect(
        server.url,
        {
          roomId: authority.roomId,
          seatToken: authority.seatToken,
          contract: createCompatibilityContract(RELEASE_ID),
        },
        { 'cf-connecting-ip': '192.0.2.7', 'x-forwarded-for': '192.0.2.99' },
      );
      expect(client.connected).toBeTrue();
      expect(acquire).toHaveBeenCalledWith('192.0.2.7', expect.any(String));
    } finally {
      acquire.mockRestore();
    }
  });

  test('rejects a browser WebSocket handshake from an unconfigured origin', async () => {
    const server = await startGameServer({
      config: {
        allowedOrigins: ['https://yacht.example'],
        trustRenderProxy: false,
        host: '127.0.0.1',
        port: 0,
        releaseId: RELEASE_ID,
      },
    });
    servers.push(server);

    const client = createClient(server.url, {
      autoConnect: false,
      extraHeaders: { origin: 'https://untrusted.example' },
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
    });
    clients.push(client);
    const error = await new Promise<Error>((resolve) => {
      client.once('connect_error', resolve);
      client.connect();
    });
    expect(error.message).toBe('websocket error');
    expect(client.connected).toBeFalse();
  });

  test('advertises the canonical heartbeat values in the Engine.IO opening packet', async () => {
    const server = await startGameServer({
      config: {
        allowedOrigins: ['https://yacht.example'],
        trustRenderProxy: false,
        host: '127.0.0.1',
        port: 0,
        releaseId: RELEASE_ID,
      },
    });
    servers.push(server);

    const client = new WebSocket(`${server.url}${GAME_SOCKET_PATH}/?EIO=4&transport=websocket`, {
      headers: { origin: 'https://yacht.example' },
    });
    try {
      const rawPacket = await receiveWebSocketMessage(client);
      expect(rawPacket.charAt(0)).toBe('0');
      const packet = parseEngineIoOpenPacket(rawPacket.slice(1));
      expect(packet.pingInterval).toBe(20_000);
      expect(packet.pingTimeout).toBe(15_000);
    } finally {
      client.close();
    }
  });
});
function receiveWebSocketMessage(client: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = { value: undefined as ReturnType<typeof setTimeout> | undefined };
    const cleanup = () => {
      if (timer.value !== undefined) clearTimeout(timer.value);
      client.onmessage = null;
      client.onerror = null;
      client.onclose = null;
    };
    client.onmessage = (event) => {
      cleanup();
      resolve(String(event.data));
    };
    client.onerror = () => {
      cleanup();
      reject(new Error('WebSocket opening packet error'));
    };
    client.onclose = () => {
      cleanup();
      reject(new Error('WebSocket closed before Engine.IO opening packet'));
    };
    timer.value = setTimeout(() => {
      cleanup();
      reject(new Error('Engine.IO opening packet timeout'));
    }, 2_000);
  });
}

function parseEngineIoOpenPacket(rawPacket: string): {
  readonly sid: string;
  readonly pingInterval: number;
  readonly pingTimeout: number;
} {
  const packet: unknown = JSON.parse(rawPacket);
  if (typeof packet !== 'object' || packet === null || Array.isArray(packet)) {
    throw new Error('Engine.IO opening packet must be a JSON object');
  }
  const object = packet as Record<string, unknown>;
  if (
    typeof object.sid !== 'string' ||
    typeof object.pingInterval !== 'number' ||
    typeof object.pingTimeout !== 'number'
  ) {
    throw new Error('Engine.IO opening packet has an invalid shape');
  }
  return {
    sid: object.sid,
    pingInterval: object.pingInterval,
    pingTimeout: object.pingTimeout,
  };
}
