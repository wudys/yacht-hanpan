import { createPublicError, PUBLIC_ERROR_CODE, type PublicError } from '@repo/game-protocol/errors';
import {
  type ClientToServerEvents,
  parseSocketAuth,
  parseSocketConnectionFailure,
  type ServerToClientEvents,
  SOCKET_EVENT,
  type SocketAuth,
} from '@repo/game-protocol/socket';
import {
  assertExactCompatibility,
  type CompatibilityContract,
  GAME_PROTOCOL_VERSION,
} from '@repo/game-protocol/version';
import type { SeatIndex } from '@repo/yacht-rules';
import type { Server as SocketIoServer, Socket } from 'socket.io';

import type { RoomId } from '@/rooms/domain/room-model';
import type { RoomApplicationService } from '@/rooms/room-application';
import type { Clock } from '@/runtime/clock';
import { type ErrorReporter, reportUnexpected } from '@/runtime/error-reporter';
import type { Logger } from '@/runtime/logger';
import type { ServerIdentity } from '@/runtime/server-identity';
import type { SocketConnectionLimit } from '@/transport/socket/socket-connection-limit';

export interface SocketData {
  roomId: RoomId;
  seatIndex: SeatIndex;
}

export type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type GameSocketIoServer = SocketIoServer<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;

interface PendingConnection {
  readonly socket: GameSocket;
  roomId: string | null;
  phase: 'authenticating' | 'admitted' | 'closed';
  disconnectedAt: number | null;
  admissionReleased: boolean;
}

export interface SocketConnectionLifecycleDependencies {
  readonly maxAuthentications?: number;
  readonly clock: Clock;
  readonly connectionLimit: SocketConnectionLimit;
  readonly expectedContract: CompatibilityContract;
  readonly identity: Pick<ServerIdentity, 'createRequestId'>;
  readonly isAcceptingRequests: () => boolean;
  readonly logger: Logger;
  readonly reportUnexpected?: ErrorReporter;
  readonly rooms: Pick<RoomApplicationService, 'connectSeat' | 'disconnectSeat'>;
  readonly resolveClientAddress: (socket: GameSocket) => string;
}

export function createSocketConnectionLifecycle(
  io: GameSocketIoServer,
  dependencies: SocketConnectionLifecycleDependencies,
) {
  // Namespace sockets exist only after authentication finishes.
  const pendingConnections = new Map<string, PendingConnection>();
  const authenticate = async (socket: GameSocket, next: (error?: Error) => void): Promise<void> => {
    const directAddress = dependencies.resolveClientAddress(socket);
    if (
      pendingConnections.size >= (dependencies.maxAuthentications ?? 64) ||
      !dependencies.connectionLimit.acquire(directAddress, socket.id)
    ) {
      next(
        connectionError(
          createPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED, { retryAfterMs: 1_000 }),
          dependencies,
        ),
      );
      return;
    }
    const pendingConnection: PendingConnection = {
      socket,
      roomId: null,
      phase: 'authenticating',
      disconnectedAt: null,
      admissionReleased: false,
    };
    pendingConnections.set(socket.id, pendingConnection);

    const onDisconnected = (): void => {
      if (pendingConnection.disconnectedAt !== null) return;
      pendingConnection.disconnectedAt = dependencies.clock.now();
      const admitted = pendingConnection.phase === 'admitted';
      pendingConnection.phase = 'closed';
      releaseAdmission();
      if (admitted) void handleDisconnect(socket, pendingConnection.disconnectedAt, dependencies);
    };
    socket.conn.once('close', onDisconnected);
    function releaseAdmission(): void {
      if (pendingConnection.admissionReleased) return;
      pendingConnection.admissionReleased = true;
      pendingConnection.phase = 'closed';
      pendingConnections.delete(socket.id);
      socket.conn.off('close', onDisconnected);
      socket.off('disconnect', onDisconnected);
      dependencies.connectionLimit.release(directAddress, socket.id);
    }

    let auth: SocketAuth;
    try {
      auth = parseSocketAuth(socket.handshake.auth);
      pendingConnection.roomId = auth.roomId;
    } catch {
      releaseAdmission();
      next(
        connectionError(
          createPublicError(authFailureCode(socket.handshake.auth, dependencies), {}),
          dependencies,
        ),
      );
      return;
    }

    const connectedAt = dependencies.clock.now();
    let result;
    try {
      result = dependencies.isAcceptingRequests()
        ? await dependencies.rooms.connectSeat({ auth, connectedAt, connectionId: socket.id })
        : { ok: false as const, error: createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {}) };
    } catch (error) {
      releaseAdmission();
      reportUnexpected(dependencies.reportUnexpected, error, 'socket.connection');
      dependencies.logger.error('socket.connection.failed', {
        connectionId: socket.id,
        error,
      });
      next(connectionError(createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {}), dependencies));
      return;
    }
    if (!result.ok) {
      releaseAdmission();
      next(connectionError(result.error, dependencies));
      return;
    }

    Object.assign(socket.data, {
      roomId: result.data.roomId,
      seatIndex: result.data.seatIndex,
    });
    const previous = result.data.previousConnectionId;
    if (previous !== null && previous !== socket.id) {
      const previousSocket =
        io.sockets.sockets.get(previous) ?? pendingConnections.get(previous)?.socket;
      if (previousSocket?.connected) {
        if (result.data.replacedExecution) previousSocket.emit(SOCKET_EVENT.SESSION_REPLACED);
        previousSocket.disconnect(true);
      } else {
        previousSocket?.conn.close();
      }
    }
    if (pendingConnection.disconnectedAt !== null) {
      await handleDisconnect(socket, pendingConnection.disconnectedAt, dependencies);
      next();
      return;
    }
    pendingConnection.phase = 'admitted';
    socket.once('disconnect', onDisconnected);
    await socket.join(String(result.data.roomId));
    if (pendingConnection.disconnectedAt !== null) {
      next();
      return;
    }
    dependencies.logger.debug('socket.connection.accepted', {
      connectionId: socket.id,
      roomId: result.data.roomId,
      seatIndex: result.data.seatIndex,
    });
    next();
  };
  return {
    authenticate,
    completeConnection: (socket: GameSocket): void => {
      pendingConnections.delete(socket.id);
    },
    closePendingRoom: (roomId: RoomId): void => {
      const key = String(roomId);
      for (const { socket, roomId: pendingRoomId } of pendingConnections.values()) {
        if (pendingRoomId === key) socket.conn.close();
      }
    },
    pendingCount: (): number => pendingConnections.size,
  };
}

async function handleDisconnect(
  socket: GameSocket,
  disconnectedAt: number,
  dependencies: SocketConnectionLifecycleDependencies,
): Promise<void> {
  try {
    const presenceChanged = await dependencies.rooms.disconnectSeat({
      roomId: socket.data.roomId,
      seatIndex: socket.data.seatIndex,
      connectionId: socket.id,
      disconnectedAt,
    });
    dependencies.logger.debug('socket.connection.closed', {
      connectionId: socket.id,
      roomId: socket.data.roomId,
      seatIndex: socket.data.seatIndex,
      presenceChanged,
    });
  } catch (error) {
    reportUnexpected(dependencies.reportUnexpected, error, 'socket.disconnect');
    dependencies.logger.error('socket.disconnection.failed', {
      connectionId: socket.id,
      roomId: socket.data.roomId,
      seatIndex: socket.data.seatIndex,
      error,
    });
  }
}

function authFailureCode(
  raw: unknown,
  dependencies: SocketConnectionLifecycleDependencies,
): typeof PUBLIC_ERROR_CODE.INVALID_AUTHORITY | typeof PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH {
  if (typeof raw !== 'object' || raw === null || !('contract' in raw)) {
    return PUBLIC_ERROR_CODE.INVALID_AUTHORITY;
  }
  try {
    assertExactCompatibility(raw.contract, dependencies.expectedContract);
    return PUBLIC_ERROR_CODE.INVALID_AUTHORITY;
  } catch {
    return PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH;
  }
}

function connectionError(
  publicError: PublicError,
  dependencies: SocketConnectionLifecycleDependencies,
): Error {
  const requestId = dependencies.identity.createRequestId();
  dependencies.logger.warn('socket.connection.rejected', {
    requestId,
    publicCode: publicError.code,
  });
  const error = new Error('SOCKET_CONNECTION_REJECTED') as Error & { data?: unknown };
  error.data = parseSocketConnectionFailure({
    ok: false,
    error: publicError,
    meta: {
      requestId,
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
    },
  });
  return error;
}
