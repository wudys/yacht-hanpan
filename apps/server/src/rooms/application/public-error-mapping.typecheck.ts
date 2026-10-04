import { createPublicError } from '@repo/game-protocol/errors';

import { mapMatchRejection, mapRoomRejection } from '@/rooms/application/public-error-mapping';
import type { MatchRejectionCode, RollApplicationFailure } from '@/rooms/domain/match';
import type { RoomRejectionCode } from '@/rooms/domain/room-constants';

export function checkDomainMappings(
  room: RoomRejectionCode,
  match: MatchRejectionCode,
  rollFailure: RollApplicationFailure,
) {
  const roomCode = mapRoomRejection(room);
  const matchCode = mapMatchRejection(match);
  createPublicError(roomCode, {});
  createPublicError(matchCode, {});
  // @ts-expect-error Domain mappings never produce parameterized public errors.
  createPublicError(roomCode, { retryAfterMs: 1_000 });
  // @ts-expect-error Domain mappings never produce parameterized public errors.
  createPublicError(matchCode, { retryAfterMs: 1_000 });
  // @ts-expect-error Roll application failures are not ordinary match rule rejections.
  mapMatchRejection(rollFailure.reason);
}
