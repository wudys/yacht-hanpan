import { PUBLIC_ERROR_CODE, type PublicError } from '@repo/game-protocol/errors';

import type { ProtocolErrorCode, TransportErrorCode } from './codes';
import { CLIENT_ERROR_CODE } from './codes';

interface ErrorCorrelation {
  readonly requestId?: string;
  readonly actionId?: string;
}

export interface ServerClientError extends ErrorCorrelation {
  readonly kind: 'server';
  readonly error: PublicError;
}

export interface TransportClientError extends ErrorCorrelation {
  readonly kind: 'transport';
  readonly code: TransportErrorCode;
}

export interface ProtocolClientError extends ErrorCorrelation {
  readonly kind: 'protocol';
  readonly code: ProtocolErrorCode;
}

export type ClientError = ServerClientError | TransportClientError | ProtocolClientError;

export function createServerError(
  error: PublicError,
  correlation: ErrorCorrelation = {},
): ServerClientError {
  return { kind: 'server', error, ...correlation };
}

export function createConnectionError(error: PublicError, requestId?: string): ClientError {
  if (error.code === PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH) {
    return createProtocolError(CLIENT_ERROR_CODE.PROTOCOL_MISMATCH, { requestId });
  }
  return createServerError(error, { requestId });
}

export function createTransportError(
  code: TransportErrorCode,
  correlation: ErrorCorrelation = {},
): TransportClientError {
  return {
    kind: 'transport',
    code,
    ...(correlation.requestId === undefined ? {} : { requestId: correlation.requestId }),
    ...(correlation.actionId === undefined ? {} : { actionId: correlation.actionId }),
  };
}

export function createProtocolError(
  code: ProtocolErrorCode,
  correlation: ErrorCorrelation = {},
): ProtocolClientError {
  return { kind: 'protocol', code, ...correlation };
}
