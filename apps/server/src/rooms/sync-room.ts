import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
} from '@repo/game-protocol/errors';
import type { RoomView } from '@repo/game-protocol/socket';
import type { SeatIndex } from '@repo/yacht-rules';

import type { RoomId } from '@/rooms/domain/room-model';
import { projectRoomView } from '@/rooms/projection/room-view';
import type { RoomRepositoryReader } from '@/rooms/repository';
import { runRoomRequest } from '@/rooms/request-admission';
import type { RoomTaskQueue } from '@/rooms/scheduling/room-task-queue';

export type SyncRoomData = RoomView;

export interface SyncRoomDependencies {
  readonly queue: RoomTaskQueue;
  readonly repository: RoomRepositoryReader;
}

export function executeSyncRoom(
  input: { readonly roomId: RoomId; readonly seatIndex: SeatIndex },
  dependencies: SyncRoomDependencies,
): Promise<ProtocolResult<SyncRoomData>> {
  return runRoomRequest<SyncRoomData>(dependencies.queue, input.roomId, () => {
    const current = dependencies.repository.getById(input.roomId);
    if (current === undefined || current.room.seats[input.seatIndex] === undefined) {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, {}),
      };
    }
    return {
      ok: true,
      data: projectRoomView(current),
    };
  });
}
