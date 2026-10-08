import {
  CLIENT_ERROR_CODE,
  type ClientError,
  createProtocolError,
  createTransportError,
} from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';

import {
  CLIENT_ERROR_MESSAGE_KEY,
  type MessageKeyWithoutParams,
  PUBLIC_ERROR_MESSAGE_KEY,
} from '@/i18n';
import type { ReadinessFailure } from '@/runtime/room-access/room-access';

export type LobbyError =
  | Readonly<{ kind: 'rate-limited'; retryAfterMs: number }>
  | Readonly<{ kind: 'incomplete-code' }>
  | Readonly<{
      kind: 'request';
      key: Exclude<MessageKeyWithoutParams, 'error.rateLimited' | 'lobby.joinCodeIncomplete'>;
    }>;

export function lobbyErrorKey(error: LobbyError): MessageKeyWithoutParams {
  switch (error.kind) {
    case 'rate-limited':
      return 'error.rateLimited';
    case 'incomplete-code':
      return 'lobby.joinCodeIncomplete';
    case 'request':
      return error.key;
  }
}

export function lobbyError(error: ClientError): LobbyError {
  if (error.kind === 'server') {
    if (error.error.code === PUBLIC_ERROR_CODE.RATE_LIMITED) {
      return { kind: 'rate-limited', retryAfterMs: error.error.params.retryAfterMs };
    }
    const key = PUBLIC_ERROR_MESSAGE_KEY[error.error.code];
    return { kind: 'request', key };
  }
  return { kind: 'request', key: CLIENT_ERROR_MESSAGE_KEY[error.code] };
}

export function isServerError(error: ClientError, code: string): boolean {
  return error.kind === 'server' && error.error.code === code;
}
export function isInlineJoinError(error: ClientError): boolean {
  return [
    PUBLIC_ERROR_CODE.ROOM_NOT_FOUND,
    PUBLIC_ERROR_CODE.ROOM_NOT_JOINABLE,
    PUBLIC_ERROR_CODE.RATE_LIMITED,
  ].some((code) => isServerError(error, code));
}
export function createFailureDisposition(error: ClientError): 'dismiss' | 'refresh' | 'notice' {
  if (error.kind === 'protocol') return 'refresh';
  if (error.kind === 'transport')
    return error.code === CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE ? 'dismiss' : 'refresh';
  if (error.error.code === PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH) return 'refresh';
  if (
    [PUBLIC_ERROR_CODE.INTERNAL_ERROR, PUBLIC_ERROR_CODE.ROOM_CODE_EXHAUSTED].some(
      (code) => code === error.error.code,
    )
  )
    return 'dismiss';
  return 'notice';
}
export function readinessFailureDisposition(result: ReadinessFailure): 'retry' | 'refresh' {
  return result.reason === 'incompatible' || result.reason === 'invalid-response'
    ? 'refresh'
    : 'retry';
}
export function readinessError(result: ReadinessFailure): ClientError {
  if (readinessFailureDisposition(result) === 'retry')
    return createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE);
  return createProtocolError(
    result.reason === 'invalid-response'
      ? CLIENT_ERROR_CODE.INVALID_RESPONSE
      : CLIENT_ERROR_CODE.PROTOCOL_MISMATCH,
  );
}

export function connectionFailureError(error: ClientError | null): LobbyError {
  return error &&
    error.kind !== 'transport' &&
    !(error.kind === 'protocol' && error.code === CLIENT_ERROR_CODE.SESSION_DISPOSED)
    ? lobbyError(error)
    : { kind: 'request', key: 'lobby.reentryRefresh' };
}
