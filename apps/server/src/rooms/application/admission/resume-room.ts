import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
} from '@repo/game-protocol/errors';
import type { ResumeRoomRequest } from '@repo/game-protocol/http';
import type { RoomView } from '@repo/game-protocol/socket';
import type { SeatIndex } from '@repo/yacht-rules';

import { resolveSeatIndexForToken } from '@/rooms/application/connections/seat-token';
import { projectRoomView } from '@/rooms/application/projection/room-view';
import type { RoomRepositoryReader } from '@/rooms/application/room-repository';
import type { RoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { runRoomRequest } from '@/rooms/application/scheduling/run-room-request';
import { evaluateSeatResume } from '@/rooms/domain/resume';
import { roomId } from '@/rooms/domain/room-model';
import type { Clock } from '@/runtime/clock';

export interface ResumeRoomData {
  readonly seatIndex: SeatIndex;
  readonly view: RoomView;
}

export type ResumeRoomApplicationResult = ProtocolResult<ResumeRoomData>;

export interface ResumeRoomDependencies {
  readonly clock: Clock;
  readonly queue: RoomTaskQueue;
  readonly repository: RoomRepositoryReader;
}

export function executeResumeRoom(
  request: ResumeRoomRequest,
  dependencies: ResumeRoomDependencies,
): Promise<ResumeRoomApplicationResult> {
  const checkedAt: number = dependencies.clock.now();
  const requestedRoomId = roomId(String(request.roomId));

  return runRoomRequest<ResumeRoomData>(dependencies.queue, requestedRoomId, () => {
    const current = dependencies.repository.getById(requestedRoomId);
    if (current === undefined) {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, {}),
      };
    }

    const seatIndex = resolveSeatIndexForToken(request.seatToken, current.credentialHashes);
    if (seatIndex === undefined) {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, {}),
      };
    }

    const eligible = evaluateSeatResume(current, { seatIndex, resumedAt: checkedAt });
    if (!eligible.ok) {
      return { ok: false, error: createPublicError(PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, {}) };
    }

    return {
      ok: true,
      data: {
        seatIndex,
        view: projectRoomView(current),
      },
    };
  });
}
