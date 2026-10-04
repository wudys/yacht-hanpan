import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
} from '@repo/game-protocol/errors';
import type { CancelRoomRequest } from '@repo/game-protocol/http';

import { resolveSeatIndexForToken } from '@/rooms/application/connections/seat-token';
import type { RoomRepositoryReader } from '@/rooms/application/room-repository';
import type { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import type { RoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { runRoomRequest } from '@/rooms/application/scheduling/run-room-request';
import { roomId } from '@/rooms/domain/room-model';

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
