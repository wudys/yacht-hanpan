import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { describe, expect, test } from 'bun:test';

import {
  CLIENT_ERROR_CODE,
  createProtocolError,
  createServerError,
  createTransportError,
} from './index';

describe('client errors', () => {
  test('uses one stable constant catalog', () => {
    expect(Object.values(CLIENT_ERROR_CODE)).toEqual([
      'NETWORK_UNAVAILABLE',
      'ACK_TIMEOUT',
      'SOCKET_DISCONNECTED',
      'PROTOCOL_MISMATCH',
      'INVALID_RESPONSE',
      'SESSION_DISPOSED',
      'STATE_UNAVAILABLE',
    ]);
  });

  test('keeps server, transport, and protocol failures discriminated with correlation', () => {
    const server = createServerError(
      { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: 500 } },
      { requestId: 'request-id', actionId: 'action-id' },
    );
    const transport = createTransportError(CLIENT_ERROR_CODE.ACK_TIMEOUT, {
      actionId: 'action-id',
    });
    const protocol = createProtocolError(CLIENT_ERROR_CODE.PROTOCOL_MISMATCH, {
      requestId: 'request-id',
    });

    expect(server).toMatchObject({ kind: 'server', requestId: 'request-id' });
    expect(transport).toEqual({ kind: 'transport', code: 'ACK_TIMEOUT', actionId: 'action-id' });
    expect(protocol).toMatchObject({ kind: 'protocol', code: 'PROTOCOL_MISMATCH' });
  });
});
