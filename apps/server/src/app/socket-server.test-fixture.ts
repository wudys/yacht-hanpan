import { createServer } from 'node:http';

import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomResponse } from '@repo/game-protocol/http';
import { GAME_SOCKET_PATH } from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';

import { type GameServer, startGameServer } from '@/app/start-game-server';
import { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import type { ErrorReporter } from '@/runtime/error-reporter';
import { createProductionIdentity } from '@/runtime/server-identity';
import { SocketConnectionLimit } from '@/transport/socket/socket-connection-limit';
import {
  attachGameSocketServer,
  type AttachGameSocketServerDependencies,
} from '@/transport/socket/socket-server';

export const RELEASE_ID = 'test-release';

export function createSocketServerTestFixture(): {
  readonly servers: GameServer[];
  readonly clients: ClientSocket[];
  readonly connect: (
    url: string,
    auth: object,
    extraHeaders?: Record<string, string>,
  ) => Promise<ClientSocket>;
  readonly startFaultServer: (
    onError?: (event: string) => void,
    onReport?: ErrorReporter,
  ) => Promise<{
    readonly errorEvents: string[];
    readonly reports: Array<Parameters<ErrorReporter>>;
    readonly repository: InMemoryRoomRepository;
    readonly server: GameServer;
  }>;
  readonly close: () => Promise<void>;
} {
  const servers: GameServer[] = [];
  const clients: ClientSocket[] = [];

  async function connect(
    url: string,
    auth: object,
    extraHeaders?: Record<string, string>,
  ): Promise<ClientSocket> {
    const client = createClient(url, {
      extraHeaders,
      auth: { executionId: crypto.randomUUID(), connectionIntent: 'enter', ...auth },
      autoConnect: false,
      path: GAME_SOCKET_PATH,
      transports: ['websocket'],
    });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
      client.connect();
    });
    return client;
  }

  async function startFaultServer(
    onError?: (event: string) => void,
    onReport?: ErrorReporter,
  ): Promise<{
    readonly errorEvents: string[];
    readonly reports: Array<Parameters<ErrorReporter>>;
    readonly repository: InMemoryRoomRepository;
    readonly server: GameServer;
  }> {
    const repository = new InMemoryRoomRepository();
    const errorEvents: string[] = [];
    const reports: Array<Parameters<ErrorReporter>> = [];
    const server = await startGameServer({
      config: {
        allowedOrigins: [],
        trustRenderProxy: false,
        host: '127.0.0.1',
        port: 0,
        releaseId: RELEASE_ID,
      },
      logger: {
        debug: () => undefined,
        error: (event) => {
          errorEvents.push(event);
          onError?.(event);
        },
        info: () => undefined,
        warn: () => undefined,
      },
      repository,
      reportUnexpected: (error, operation) => {
        reports.push([error, operation]);
        onReport?.(error, operation);
      },
    });
    servers.push(server);
    return { errorEvents, repository, server, reports };
  }

  async function close() {
    for (const client of clients.splice(0)) client.disconnect();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  }

  return { servers, clients, connect, startFaultServer, close };
}

export async function startAdmissionServer(
  limits: Pick<
    AttachGameSocketServerDependencies,
    'maxTransports' | 'maxAuthentications' | 'authenticationTimeoutMs'
  >,
  connectSeat: AttachGameSocketServerDependencies['rooms']['connectSeat'] = async () => ({
    ok: false,
    error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} },
  }),
  reportUnexpected?: ErrorReporter,
) {
  const httpServer = createServer();
  const connectionLimit = new SocketConnectionLimit();
  const socketServer = attachGameSocketServer(httpServer, {
    ...limits,
    allowedOrigins: [],
    clock: { now: () => Date.now() },
    connectionLimit,
    reportUnexpected,
    expectedContract: createCompatibilityContract(RELEASE_ID),
    identity: createProductionIdentity(),
    isAcceptingRequests: () => true,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    resolveClientAddress: () => 'test-address',
    rooms: {
      connectSeat,
      disconnectSeat: async () => false,
      executeGameCommand: async () => {
        throw new Error('unexpected command');
      },
      syncRoom: async () => {
        throw new Error('unexpected sync');
      },
    },
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('missing server address');
  return { socketServer, connectionLimit, url: `http://127.0.0.1:${address.port}` };
}

export async function createTestRoom(
  url: string,
  operationId: string,
): Promise<{ readonly roomId: string; readonly seatToken: string }> {
  const created = parseCreateRoomResponse(
    (
      await post(`${url}/rooms`, {
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        operationId,
        profile: { characterId: 'navy-bob', variant: false },
      })
    ).body,
  );
  if (!created.ok) throw new Error('create failed');
  return created.data.authority;
}

export function onceEvent(client: ClientSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => client.once(event, resolve));
}

export function emitAck(client: ClientSocket, event: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    if (payload === undefined) client.emit(event, resolve);
    else client.emit(event, payload, resolve);
  });
}

export async function emitAckWithin(
  client: ClientSocket,
  event: string,
  payload?: unknown,
): Promise<unknown> {
  return within(emitAck(client, event, payload), `Socket ack: ${event}`);
}

export async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), 1_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contract: createCompatibilityContract(RELEASE_ID), body }),
  });
  return { status: response.status, body: await response.json() };
}
