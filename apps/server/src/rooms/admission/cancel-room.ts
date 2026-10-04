import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
} from '@repo/game-protocol/errors';
import type { CancelRoomRequest } from '@repo/game-protocol/http';

import type { RoomStateCommitter } from '@/rooms/commit';
import { resolveSeatIndexForToken } from '@/rooms/connections/seat-token';
import { roomId } from '@/rooms/domain/room-model';
import type { RoomRepositoryReader } from '@/rooms/repository';
import { runRoomRequest } from '@/rooms/request-admission';
import type { RoomTaskQueue } from '@/rooms/scheduling/room-task-queue';

export type CancelRoomApplicationResult = ProtocolResult<{ readonly cancelled: true }>;

export interface CancelRoomDependencies {
  readonly queue: RoomTaskQueue;
  readonly repository: RoomRepositoryReader;
  readonly commits: Pick<RoomStateCommitter, 'remove'>;
}

export function executeCancelRoom(
  request: CancelRoomRequest,
  dependencies: CancelRoomDependencies,
): Promise<CancelRoomApplicationResult> {
  const requestedRoomId = roomId(String(request.roomId));
  return runRoomRequest<{ readonly cancelled: true }>(dependencies.queue, requestedRoomId, () => {
    const current = dependencies.repository.getById(requestedRoomId);
    if (current === undefined) return { ok: true, data: { cancelled: true } };
    if (resolveSeatIndexForToken(request.seatToken, current.credentialHashes) !== 0) {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.INVALID_AUTHORITY, {}),
      };
    }
    if (current.match !== null) {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.ROOM_ALREADY_MATCHED, {}),
      };
    }
    if (!dependencies.commits.remove(current)) {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {}),
      };
    }
    return { ok: true, data: { cancelled: true } };
  });
}
