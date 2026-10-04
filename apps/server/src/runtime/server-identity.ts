import { randomInt } from 'node:crypto';

import { v4 as uuidV4, v7 as uuidV7 } from 'uuid';

export interface ServerIdentity {
  readonly createRequestId: () => string;
  readonly createRoomCodeCandidate: () => string;
  readonly createRoomId: () => string;
  readonly createSeatToken: () => string;
  readonly createTurnId: () => string;
}

export function createProductionIdentity(): ServerIdentity {
  return {
    createRequestId: uuidV7,
    createRoomCodeCandidate: () => randomInt(0, 1_000_000).toString().padStart(6, '0'),
    createRoomId: uuidV7,
    createSeatToken: uuidV4,
    createTurnId: uuidV7,
  };
}
