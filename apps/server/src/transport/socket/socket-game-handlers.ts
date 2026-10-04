import { createPublicError, PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  type CommandAck,
  parseCommandAck,
  parseGameCommand,
  parseSyncAck,
  type SyncAck,
} from '@repo/game-protocol/socket';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import type { SeatIndex } from '@repo/yacht-rules';

import type { RoomId } from '@/rooms/domain/room-model';
import type { RoomApplicationService } from '@/rooms/room-application';
import type { Clock } from '@/runtime/clock';
import { type ErrorReporter, reportUnexpected } from '@/runtime/error-reporter';
import type { Logger } from '@/runtime/logger';
import type { ServerIdentity } from '@/runtime/server-identity';

interface SocketGameContext {
  readonly data: { readonly roomId: RoomId; readonly seatIndex: SeatIndex };
}

interface SocketGameHandlerDependencies {
  readonly clock: Clock;
  readonly identity: Pick<ServerIdentity, 'createRequestId'>;
  readonly isAcceptingRequests: () => boolean;
  readonly logger: Logger;
  readonly reportUnexpected?: ErrorReporter;
  readonly rooms: Pick<RoomApplicationService, 'executeGameCommand' | 'syncRoom'>;
}

export async function handleSync(
  socket: SocketGameContext,
  acknowledge: (response: SyncAck) => void,
  dependencies: SocketGameHandlerDependencies,
  admitted: boolean = true,
): Promise<void> {
  const requestId = dependencies.identity.createRequestId();
  let ack: SyncAck;
  try {
    const result =
      admitted && dependencies.isAcceptingRequests()
        ? await dependencies.rooms.syncRoom(socket.data)
        : {
            ok: false as const,
            error: admitted
              ? createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {})
              : createPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED, { retryAfterMs: 1_000 }),
          };
    ack = parseSyncAck({
      ...result,
      meta: {
        requestId,
        gameProtocolVersion: GAME_PROTOCOL_VERSION,
        ...(result.ok ? { serverTime: dependencies.clock.now() } : {}),
      },
    });
  } catch (error) {
    reportUnexpected(dependencies.reportUnexpected, error, 'socket.sync');
    dependencies.logger.error('socket.sync.failed', {
      roomId: socket.data.roomId,
      seatIndex: socket.data.seatIndex,
      error,
    });
    ack = parseSyncAck({
      ok: false,
      error: createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {}),
      meta: { requestId, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
  }
  acknowledgeSafely(acknowledge, ack, socket, dependencies, 'socket.sync');
}

export async function handleCommand(
  socket: SocketGameContext,
  rawCommand: unknown,
  acknowledge: (response: CommandAck) => void,
  receivedAt: number,
  dependencies: SocketGameHandlerDependencies,
  admitted: boolean,
): Promise<void> {
  const requestId = dependencies.identity.createRequestId();
  let command;
  try {
    command = parseGameCommand(rawCommand);
  } catch {
    acknowledgeSafely(
      acknowledge,
      parseCommandAck({
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {}),
        meta: { requestId, gameProtocolVersion: GAME_PROTOCOL_VERSION, actionId: null },
      }),
      socket,
      dependencies,
      'socket.command',
    );
    return;
  }

  let execution;
  let ack: CommandAck;
  try {
    execution =
      admitted && dependencies.isAcceptingRequests()
        ? await dependencies.rooms.executeGameCommand({
            roomId: socket.data.roomId,
            seatIndex: socket.data.seatIndex,
            command,
            receivedAt,
          })
        : {
            result: {
              ok: false as const,
              error: admitted
                ? createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {})
                : createPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED, { retryAfterMs: 1_000 }),
            },
            committedStateVersion: null,
          };
    ack = parseCommandAck({
      ...execution.result,
      meta: { requestId, gameProtocolVersion: GAME_PROTOCOL_VERSION, actionId: command.actionId },
    });
  } catch (error) {
    reportUnexpected(dependencies.reportUnexpected, error, 'socket.command');
    dependencies.logger.error('socket.command.failed', {
      roomId: socket.data.roomId,
      seatIndex: socket.data.seatIndex,
      actionId: command.actionId,
      error,
    });
    execution = {
      result: {
        ok: false as const,
        error: createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {}),
      },
      committedStateVersion: null,
    };
    ack = parseCommandAck({
      ...execution.result,
      meta: { requestId, gameProtocolVersion: GAME_PROTOCOL_VERSION, actionId: command.actionId },
    });
  }
  acknowledgeSafely(acknowledge, ack, socket, dependencies, 'socket.command');
  const log = execution.result.ok ? dependencies.logger.debug : dependencies.logger.warn;
  log('socket.command.completed', {
    requestId,
    roomId: socket.data.roomId,
    seatIndex: socket.data.seatIndex,
    actionId: command.actionId,
    commandType: command.type,
    ok: execution.result.ok,
    publicCode: execution.result.ok ? null : execution.result.error.code,
    committedStateVersion: execution.committedStateVersion,
    receiptStateVersion: execution.result.ok ? execution.result.data.receipt.stateVersion : null,
    viewStateVersion: execution.result.ok ? execution.result.data.view.game?.stateVersion : null,
  });
}

function acknowledgeSafely<Response>(
  acknowledge: (response: Response) => void,
  response: Response,
  socket: SocketGameContext,
  dependencies: SocketGameHandlerDependencies,
  operation: 'socket.sync' | 'socket.command',
): void {
  try {
    acknowledge(response);
  } catch (error) {
    reportUnexpected(dependencies.reportUnexpected, error, operation);
    dependencies.logger.error(`${operation}.ack_failed`, {
      roomId: socket.data.roomId,
      seatIndex: socket.data.seatIndex,
      error,
    });
  }
}
