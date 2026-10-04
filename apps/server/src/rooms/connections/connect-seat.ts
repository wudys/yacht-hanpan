import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
} from '@repo/game-protocol/errors';
import { SOCKET_CONNECTION_INTENT, type SocketAuth } from '@repo/game-protocol/socket';
import { assertExactCompatibility, type CompatibilityContract } from '@repo/game-protocol/version';
import type { SeatIndex } from '@repo/yacht-rules';

import type { RoomStateCommitter } from '@/rooms/commit';
import type { ActiveConnectionRegistry } from '@/rooms/connections/connection-registry';
import { resolveSeatIndexForToken } from '@/rooms/connections/seat-token';
import { evaluateSeatResume } from '@/rooms/domain/resume';
import { type RoomId, roomId } from '@/rooms/domain/room-model';
import { mapCommitFailure } from '@/rooms/errors';
import type { RoomRepositoryReader } from '@/rooms/repository';
import { runRoomRequest } from '@/rooms/request-admission';
import type { RoomTaskQueue } from '@/rooms/scheduling/room-task-queue';

export interface ConnectSeatInput {
  readonly auth: SocketAuth;
  readonly connectedAt: number;
  readonly connectionId: string;
}

export interface ConnectSeatData {
  readonly roomId: RoomId;
  readonly seatIndex: SeatIndex;
  readonly previousConnectionId: string | null;
  readonly replacedExecution: boolean;
}

export type ConnectSeatResult = ProtocolResult<ConnectSeatData>;

export interface ConnectSeatDependencies {
  readonly connections: ActiveConnectionRegistry;
  readonly expectedContract: CompatibilityContract;
  readonly queue: RoomTaskQueue;
  readonly repository: RoomRepositoryReader;
  readonly commits: Pick<RoomStateCommitter, 'commitSeatConnection'>;
}

export function executeConnectSeat(
  input: ConnectSeatInput,
  dependencies: ConnectSeatDependencies,
): Promise<ConnectSeatResult> {
  try {
    assertExactCompatibility(input.auth.contract, dependencies.expectedContract);
  } catch {
    return Promise.resolve({
      ok: false,
      error: createPublicError(PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH, {}),
    });
  }

  const requestedRoomId = roomId(String(input.auth.roomId));
  return runRoomRequest<ConnectSeatData>(dependencies.queue, requestedRoomId, () => {
    const current = dependencies.repository.getById(requestedRoomId);
    if (current === undefined) return invalidAuthority();

    const seatIndex = resolveSeatIndexForToken(input.auth.seatToken, current.credentialHashes);
    if (seatIndex === undefined) return invalidAuthority();

    const resumed = evaluateSeatResume(current, { seatIndex, resumedAt: input.connectedAt });
    if (!resumed.ok) {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, {}),
      };
    }
    const previous = dependencies.connections.get(requestedRoomId, seatIndex);
    const replacedExecution =
      previous !== undefined && previous.executionId !== input.auth.executionId;
    if (replacedExecution && input.auth.connectionIntent === SOCKET_CONNECTION_INTENT.RECONNECT) {
      return { ok: false, error: createPublicError(PUBLIC_ERROR_CODE.SESSION_REPLACED, {}) };
    }
    const committed = dependencies.commits.commitSeatConnection(
      {
        current,
        room: resumed.state.room,
        seatIndex,
        connection: { connectionId: input.connectionId, executionId: input.auth.executionId },
      },
      dependencies.connections,
    );
    if (!committed.ok) {
      return {
        ok: false,
        error: mapCommitFailure(committed.reason),
      };
    }

    return {
      ok: true,
      data: {
        roomId: requestedRoomId,
        seatIndex,
        previousConnectionId: previous?.connectionId ?? null,
        replacedExecution,
      },
    };
  });
}

function invalidAuthority(): ConnectSeatResult {
  return {
    ok: false,
    error: createPublicError(PUBLIC_ERROR_CODE.INVALID_AUTHORITY, {}),
  };
}
