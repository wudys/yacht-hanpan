import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
} from '@repo/game-protocol/errors';
import type { JoinRoomRequest } from '@repo/game-protocol/http';
import type { GameSnapshot, RoomView } from '@repo/game-protocol/socket';

import { createSeatCredential } from '@/rooms/application/connections/seat-token';
import { mapCommitFailure, mapRoomRejection } from '@/rooms/application/public-error-mapping';
import type { RoomRepositoryReader } from '@/rooms/application/room-repository';
import type { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import type { RoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { runRoomRequest } from '@/rooms/application/scheduling/run-room-request';
import { joinRoom as joinRoomDomain } from '@/rooms/domain/join-room';
import { turnId } from '@/rooms/domain/match';
import { ROOM_STATUS } from '@/rooms/domain/room-constants';
import { startRoomMatch } from '@/rooms/domain/room-match-lifecycle';
import { isRoomCode } from '@/rooms/domain/room-validation';
import { epochMilliseconds } from '@/rooms/domain/time';
import type { Clock } from '@/runtime/clock';
import type { ServerIdentity } from '@/runtime/server-identity';

export interface JoinRoomData {
  readonly authority: {
    readonly roomId: string;
    readonly seatIndex: 1;
    readonly seatToken: string;
  };
  readonly view: RoomView & Readonly<{ game: GameSnapshot }>;
}

export type JoinRoomApplicationResult = ProtocolResult<JoinRoomData>;

export interface JoinRoomDependencies {
  readonly clock: Clock;
  readonly identity: Pick<ServerIdentity, 'createSeatToken' | 'createTurnId'>;
  readonly commits: Pick<RoomStateCommitter, 'commitStart'>;
  readonly queue: RoomTaskQueue;
  readonly repository: RoomRepositoryReader;
}

export function executeJoinRoom(
  request: JoinRoomRequest,
  dependencies: JoinRoomDependencies,
): Promise<JoinRoomApplicationResult> {
  const joinedAt: number = dependencies.clock.now();
  const requestedCode: string = request.roomCode;
  if (!isRoomCode(requestedCode)) {
    return Promise.resolve({
      ok: false,
      error: createPublicError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {}),
    });
  }
  const resolvedRoomId = dependencies.repository.findRoomIdByCode(requestedCode);
  if (resolvedRoomId === undefined) {
    return Promise.resolve({
      ok: false,
      error: createPublicError(PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, {}),
    });
  }

  return runRoomRequest<JoinRoomData>(dependencies.queue, resolvedRoomId, () => {
    if (dependencies.repository.findRoomIdByCode(requestedCode) !== resolvedRoomId) {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, {}),
      };
    }
    const current = dependencies.repository.getById(resolvedRoomId);
    if (
      current === undefined ||
      current.room.status !== ROOM_STATUS.WAITING ||
      current.match !== null
    ) {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.ROOM_NOT_JOINABLE, {}),
      };
    }
    const joined = joinRoomDomain(current.room, {
      characterId: request.profile.characterId,
      variant: request.profile.variant,
      joinedAt,
    });
    if (!joined.ok) {
      return { ok: false, error: createPublicError(mapRoomRejection(joined.code), {}) };
    }

    const credential = createSeatCredential(dependencies.identity);
    const state = startRoomMatch(joined.room, {
      id: turnId(dependencies.identity.createTurnId()),
      startedAt: epochMilliseconds(joinedAt),
    });
    const committed = dependencies.commits.commitStart({
      current,
      state,
      guestCredentialHash: credential.hash,
    });
    if (!committed.ok) {
      return {
        ok: false,
        error: mapCommitFailure(committed.reason),
      };
    }

    const data: JoinRoomData = {
      authority: {
        roomId: resolvedRoomId,
        seatIndex: 1,
        seatToken: credential.token,
      },
      view: committed.view,
    };
    return { ok: true, data };
  });
}
