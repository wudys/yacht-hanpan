import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
} from '@repo/game-protocol/errors';
import type { CreateRoomRequest } from '@repo/game-protocol/http';
import type { RoomView } from '@repo/game-protocol/socket';

import { type CreateRoomRateLimiter } from '@/rooms/application/admission/create-room-rate-limiter';
import { createSeatCredential } from '@/rooms/application/connections/seat-token';
import type { WaitingRoomRecord } from '@/rooms/application/room-record';
import type { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import { createRoom as createRoomDomain } from '@/rooms/domain/create-room';
import { roomId } from '@/rooms/domain/room-model';
import type { Clock } from '@/runtime/clock';
import type { ServerIdentity } from '@/runtime/server-identity';

const ROOM_CODE_ATTEMPT_LIMIT = 32;

export interface CreateRoomInput {
  readonly request: CreateRoomRequest;
  readonly ipAddress: string;
}

export interface CreateRoomData {
  readonly authority: {
    readonly roomId: string;
    readonly seatIndex: 0;
    readonly seatToken: string;
  };
  readonly view: RoomView;
}

export type CreateRoomApplicationResult = ProtocolResult<CreateRoomData>;

export interface CreateRoomDependencies {
  readonly clock: Clock;
  readonly identity: Pick<
    ServerIdentity,
    'createRoomId' | 'createRoomCodeCandidate' | 'createSeatToken'
  >;
  readonly rateLimiter: CreateRoomRateLimiter;
  readonly commits: Pick<RoomStateCommitter, 'create'>;
}

export function executeCreateRoom(
  input: CreateRoomInput,
  dependencies: CreateRoomDependencies,
): CreateRoomApplicationResult {
  const createdAt: number = dependencies.clock.now();
  const rateLimit = dependencies.rateLimiter.consume({
    ipAddress: input.ipAddress,
    attemptedAt: createdAt,
  });
  if (!rateLimit.ok) {
    return {
      ok: false,
      error: createPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED, {
        retryAfterMs: rateLimit.retryAfterMs,
      }),
    };
  }

  const generatedRoomId = roomId(dependencies.identity.createRoomId());
  const credential = createSeatCredential(dependencies.identity);

  for (let attempt: number = 0; attempt < ROOM_CODE_ATTEMPT_LIMIT; attempt += 1) {
    const created = createRoomDomain({
      roomId: generatedRoomId,
      code: dependencies.identity.createRoomCodeCandidate(),
      characterId: input.request.profile.characterId,
      variant: input.request.profile.variant,
      createdAt,
    });
    if (!created.ok) {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {}),
      };
    }

    const record: WaitingRoomRecord = {
      actionLedger: [],
      room: created.room,
      match: null,
      credentialHashes: [credential.hash],
      stateVersion: 0,
      presenceVersion: 0,
    };
    const stored = dependencies.commits.create(record);
    if (stored.ok) {
      return {
        ok: true,
        data: {
          authority: {
            roomId: generatedRoomId,
            seatIndex: 0,
            seatToken: credential.token,
          },
          view: stored.view,
        },
      };
    }
    if (stored.reason === 'capacity') {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED, { retryAfterMs: 1_000 }),
      };
    }
    if (stored.reason === 'roomIdConflict') {
      return {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {}),
      };
    }
  }

  return {
    ok: false,
    error: createPublicError(PUBLIC_ERROR_CODE.ROOM_CODE_EXHAUSTED, {}),
  };
}
