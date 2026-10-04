import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
} from '@repo/game-protocol/errors';

import type { RoomId } from '@/rooms/domain/room-model';
import type { RoomTaskQueue } from '@/rooms/scheduling/room-task-queue';

export async function runRoomRequest<Data>(
  queue: RoomTaskQueue,
  roomId: RoomId,
  operation: () => ProtocolResult<Data> | Promise<ProtocolResult<Data>>,
): Promise<ProtocolResult<Data>> {
  const admitted = await queue.runRequest(roomId, operation);
  return admitted.ok
    ? admitted.value
    : {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED, { retryAfterMs: 1_000 }),
      };
}
