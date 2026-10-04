import type { IncomingMessage, Server as HttpServer } from 'node:http';

import {
  type ClientToServerEvents,
  type CommittedRoomUpdate,
  GAME_SOCKET_PATH,
  type ServerToClientEvents,
  SOCKET_EVENT,
} from '@repo/game-protocol/socket';
import { Server as SocketIoServer } from 'socket.io';

import type { RoomId } from '@/rooms/domain/room-model';
import type { RoomApplication } from '@/rooms/room-application';
import { isBrowserOriginAllowed } from '@/transport/origin-policy';
import {
  createSocketConnectionLifecycle,
  type SocketConnectionLifecycleDependencies,
  type SocketData,
} from '@/transport/socket/socket-connection-lifecycle';
import { SocketConnectionLimit } from '@/transport/socket/socket-connection-limit';
import { handleCommand, handleSync } from '@/transport/socket/socket-game-handlers';

const SOCKET_IO_SERVER_EVENT = {
  CONNECTION: 'connection',
} as const;

const SOCKET_IO_PING_INTERVAL_MS = 20_000;
const SOCKET_IO_PING_TIMEOUT_MS = 15_000;
const MAX_PENDING_COMMAND_ACKS_PER_SOCKET = 8;

export interface AttachGameSocketServerDependencies extends Omit<
  SocketConnectionLifecycleDependencies,
  'connectionLimit'
> {
  readonly connectionLimit?: SocketConnectionLimit;
  readonly maxTransports?: number;
  readonly authenticationTimeoutMs?: number;
  readonly allowedOrigins: readonly string[];
  readonly isAcceptingRequests: () => boolean;
  readonly rooms: Pick<
    RoomApplication,
    'connectSeat' | 'disconnectSeat' | 'executeGameCommand' | 'syncRoom'
  >;
}

export interface GameSocketServer {
  readonly publishRoomUpdate: (roomId: RoomId, update: CommittedRoomUpdate) => void;
  readonly closeRoom: (roomId: RoomId, finalUpdate: CommittedRoomUpdate | null) => void;
  readonly close: () => Promise<void>;
  readonly counts: () => { readonly transports: number; readonly authenticating: number };
}

export function attachGameSocketServer(
  httpServer: HttpServer,
  dependencies: AttachGameSocketServerDependencies,
): GameSocketServer {
  const connectionLimit = dependencies.connectionLimit ?? new SocketConnectionLimit();
  const transports = new Map<IncomingMessage, () => void>();
  const io = new SocketIoServer<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    allowRequest: (request, callback) => {
      const rawOrigin = request.headers.origin;
      const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
      if (!isBrowserOriginAllowed(origin, dependencies.allowedOrigins)) {
        callback(null, false);
        return;
      }
      if (transports.size >= (dependencies.maxTransports ?? 128)) {
        callback(null, false);
        return;
      }
      const release = (): void => {
        transports.delete(request);
        request.socket.off('close', release);
      };
      transports.set(request, release);
      request.socket.once('close', release);
      callback(null, true);
    },
    connectTimeout: dependencies.authenticationTimeoutMs ?? 20_000,
    pingInterval: SOCKET_IO_PING_INTERVAL_MS,
    pingTimeout: SOCKET_IO_PING_TIMEOUT_MS,
    serveClient: false,
    maxHttpBufferSize: 16 * 1_024,
    path: GAME_SOCKET_PATH,
    transports: ['websocket'],
  });
  io.engine.on('connection', (connection) => {
    const release = transports.get(connection.request);
    if (release === undefined) return;
    connection.request.socket.off('close', release);
    connection.once('close', release);
  });
  io.engine.on('connection_error', (error: { readonly req: IncomingMessage }) => {
    transports.get(error.req)?.();
  });

  const connections = createSocketConnectionLifecycle(io, { ...dependencies, connectionLimit });
  io.use(connections.authenticate);

  io.on(SOCKET_IO_SERVER_EVENT.CONNECTION, (socket) => {
    connections.completeConnection(socket);
    let synchronizing = false;
    let pendingCommands = 0;
    socket.on(SOCKET_EVENT.GAME_SYNC, (acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      const admitted = !synchronizing;
      if (admitted) synchronizing = true;
      void handleSync(socket, acknowledge, dependencies, admitted).finally(() => {
        if (admitted) synchronizing = false;
      });
    });
    socket.on(SOCKET_EVENT.GAME_COMMAND, (rawCommand, acknowledge) => {
      if (typeof acknowledge !== 'function') return;
      const receivedAt = dependencies.clock.now();
      const admitted = pendingCommands < MAX_PENDING_COMMAND_ACKS_PER_SOCKET;
      if (admitted) pendingCommands += 1;
      void handleCommand(
        socket,
        rawCommand,
        acknowledge,
        receivedAt,
        dependencies,
        admitted,
      ).finally(() => {
        if (admitted) pendingCommands -= 1;
      });
    });
  });

  return {
    publishRoomUpdate: (roomId, update) => {
      io.to(String(roomId)).emit(SOCKET_EVENT.ROOM_STATE, update);
    },
    closeRoom: (roomId, finalUpdate) => {
      const key = String(roomId);
      if (finalUpdate !== null) io.to(key).emit(SOCKET_EVENT.ROOM_STATE, finalUpdate);
      const connectionIds = io.sockets.adapter.rooms.get(key) ?? new Set<string>();
      for (const connectionId of [...connectionIds]) {
        io.sockets.sockets.get(connectionId)?.disconnect(true);
      }
      connections.closePendingRoom(roomId);
    },
    close: () => io.close(),
    counts: () => ({ transports: transports.size, authenticating: connections.pendingCount() }),
  };
}
