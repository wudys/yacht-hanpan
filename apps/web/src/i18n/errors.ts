import { CLIENT_ERROR_CODE, type ClientErrorCode } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE, type PublicErrorCode } from '@repo/game-protocol/errors';

import type { MessageKey } from '@/i18n/catalog';

export const PUBLIC_ERROR_MESSAGE_KEY = {
  [PUBLIC_ERROR_CODE.INVALID_REQUEST]: 'error.invalidRequest',
  [PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH]: 'error.protocolMismatch',
  [PUBLIC_ERROR_CODE.ROOM_NOT_FOUND]: 'error.roomNotFound',
  [PUBLIC_ERROR_CODE.ROOM_NOT_JOINABLE]: 'error.roomNotJoinable',
  [PUBLIC_ERROR_CODE.ROOM_ALREADY_MATCHED]: 'error.roomAlreadyMatched',
  [PUBLIC_ERROR_CODE.ROOM_CODE_EXHAUSTED]: 'error.roomCodeExhausted',
  [PUBLIC_ERROR_CODE.INVALID_AUTHORITY]: 'error.invalidAuthority',
  [PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE]: 'error.resumeNotAvailable',
  [PUBLIC_ERROR_CODE.SESSION_REPLACED]: 'session.replaced',
  [PUBLIC_ERROR_CODE.NOT_YOUR_TURN]: 'error.notYourTurn',
  [PUBLIC_ERROR_CODE.STALE_TURN]: 'error.staleTurn',
  [PUBLIC_ERROR_CODE.TURN_EXPIRED]: 'error.turnExpired',
  [PUBLIC_ERROR_CODE.TURN_NOT_STARTED]: 'error.turnNotStarted',
  [PUBLIC_ERROR_CODE.ROLL_LIMIT_REACHED]: 'error.rollLimitReached',
  [PUBLIC_ERROR_CODE.NO_DICE_TO_ROLL]: 'error.noDiceToRoll',
  [PUBLIC_ERROR_CODE.HOLD_NOT_ALLOWED]: 'error.holdNotAllowed',
  [PUBLIC_ERROR_CODE.CATEGORY_ALREADY_RECORDED]: 'error.categoryAlreadyRecorded',
  [PUBLIC_ERROR_CODE.INVALID_CATEGORY]: 'error.invalidCategory',
  [PUBLIC_ERROR_CODE.MATCH_FINISHED]: 'error.matchFinished',
  [PUBLIC_ERROR_CODE.ACTION_ID_REUSED]: 'error.actionIdReused',
  [PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED]: 'error.actionResultExpired',
  [PUBLIC_ERROR_CODE.RATE_LIMITED]: 'error.rateLimited',
  [PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE]: 'error.rollUnavailable',
  [PUBLIC_ERROR_CODE.INTERNAL_ERROR]: 'error.internal',
} as const satisfies Record<PublicErrorCode, MessageKey>;

export const CLIENT_ERROR_MESSAGE_KEY = {
  [CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE]: 'error.networkUnavailable',
  [CLIENT_ERROR_CODE.ACK_TIMEOUT]: 'error.ackTimeout',
  [CLIENT_ERROR_CODE.SOCKET_DISCONNECTED]: 'error.socketDisconnected',
  [CLIENT_ERROR_CODE.PROTOCOL_MISMATCH]: 'error.protocolMismatch',
  [CLIENT_ERROR_CODE.INVALID_RESPONSE]: 'lobby.reentryRefresh',
  [CLIENT_ERROR_CODE.SESSION_DISPOSED]: 'error.sessionDisposed',
  [CLIENT_ERROR_CODE.STATE_UNAVAILABLE]: 'error.stateUnavailable',
} as const satisfies Record<ClientErrorCode, MessageKey>;
