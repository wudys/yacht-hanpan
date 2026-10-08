import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
} from '@repo/game-protocol/errors';
import type { RoomView } from '@repo/game-protocol/state';
import type { SeatIndex } from '@repo/yacht-rules';

import { projectRoomView } from '@/rooms/application/projection/room-view';
import type { RoomRepositoryReader } from '@/rooms/application/room-repository';
import type { RoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { runRoomRequest } from '@/rooms/application/scheduling/run-room-request';
import type { RoomId } from '@/rooms/domain/room-model';

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
